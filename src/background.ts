/**
 * BrowserGuard — Background Service Worker (MV3)
 * ─────────────────────────────────────────────────────────────────────────────
 * Responsibilities:
 *   1. Aggregate behavioral snapshots from content scripts
 *   2. POST periodic beacon (≥5s) to /hv/api/browserguard/session-behavior-ping
 *   3. If backend responds with step_up_required: true, open step-up.html
 *   4. Listen for step-up result from step-up.ts and notify backend
 *
 * The extension is "dumb" — it captures and obeys. All threshold logic
 * (trust_score_normalized < 65) is server-side.
 *
 * NOTE: functions are exported for unit testing (vitest). In the service
 * worker context, the `export` keywords are stripped by esbuild (the build
 * script bundles each entry point independently with no imports between
 * them), so they have no runtime effect in production. The lifecycle code
 * at the bottom (sessionIdRestored, beaconTimer, beforeunload) is guarded
 * by `isServiceWorkerContext` so it does not execute when imported in tests.
 *
 * @copyright (c) 2026 Benjamin BARRERE / IA SOLUTION
 * @license Patents Pending FR2514274 | FR2514546
 */

// Service worker context detection: chrome.runtime is only defined in the
// actual extension SW. In vitest, chrome.* is mocked but chrome.runtime.id
// is not set (or set to a test sentinel). This guard prevents the lifecycle
// code (storage restoration, beacon timer, beforeunload) from running when
// the module is imported by tests.
const isServiceWorkerContext =
  typeof chrome !== 'undefined' &&
  typeof chrome.runtime !== 'undefined' &&
  typeof chrome.runtime.id === 'string' &&
  chrome.runtime.id !== 'vitest-test-extension';

// ─── Config ─────────────────────────────────────────────────────────

const BEACON_INTERVAL_MS = 5_000; // ≥5s to stay under 20 req/min Worker rate limit
const BACKEND_URL = 'https://api.hcs-u7.org/hv/api/browserguard/session-behavior-ping';
const STEP_UP_URL_BASE = 'https://challenge.hcs-u7.org/embed/';

// ─── Types ──────────────────────────────────────────────────────────

export interface BehaviorSnapshot {
  keystrokeIntervals: number[];
  keystrokeHolds: number[];
  keystrokeCount: number;
  mouseSpeeds: number[];
  mouseCurvatures: number[];
  mousePauseCount: number;
  mouseEventCount: number;
  scrollSpeeds: number[];
  scrollPauseCount: number;
  scrollEventCount: number;
  totalEvents: number;
  timestamp: string;
  viewportWidth?: number;
  viewportHeight?: number;
  pixelRatio?: number;
}

export interface BackendResponse {
  ok: boolean;
  divergence?: number;
  consecutiveBreaches?: number;
  invalidated?: boolean;
  networkRiskScore?: number;
  referenceWindowActive?: boolean;
  longitudinalProfileFound?: boolean;
  featureBreakdown?: unknown;
  trust_score_normalized?: number | null;
  trust_scope?: string | null;
  step_up_required?: boolean;
  step_up_url?: string | null;
  error?: string;
}

export interface StepUpResultMessage {
  type: 'browserguard_stepup_result';
  decision: string;
  score: number;
  confidence: number;
  engaged: boolean;
  reason: string;
  sessionId: string;
  completedCount: number;
  plannedCount: number;
}

export interface StepUpErrorMessage {
  type: 'browserguard_stepup_error';
  error: string;
  detail: string;
  sessionId: string | null;
}

// ─── State ──────────────────────────────────────────────────────────

let sessionId: string = '';
let tenantId: string = 'browserguard-default';
let lastSnapshot: BehaviorSnapshot | null = null;
let beaconTimer: ReturnType<typeof setInterval> | null = null;
let stepUpInProgress: boolean = false;
let stepUpWindowId: number | null = null;
let stepUpSafetyTimer: ReturnType<typeof setTimeout> | null = null;
let autoBeaconPaused: boolean = false;
// Tracks whether the CURRENT session (identified by `sessionId`) has been
// invalidated by the backend. When true, sendBeacon skips immediately (no
// fetch) and the beacon timer is stopped — there is no point continuing to
// ping a session that is already closed server-side. This is reset to false
// whenever a new sessionId is generated (ensureSession) or set via test
// helper, so a new session always starts with a clean beacon cycle.
let sessionInvalidated: boolean = false;

// Safety timeout: if no result/error is received within 90s, force-reset
// stepUpInProgress so future beacons can trigger a new step-up.
// 90s > 60s (step-up.ts timeout) to let the normal close flow happen first.
const STEP_UP_SAFETY_TIMEOUT_MS = 90_000;

// ─── Session ID generation ──────────────────────────────────────────

function generateSessionId(): string {
  return `bg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

// Promise that resolves when the initial storage restoration is complete.
// This prevents ensureSession() from generating a new sessionId before the
// persisted one has been loaded from chrome.storage.local (race condition
// on MV3 service worker restarts).
let sessionIdRestored: Promise<void>;

/**
 * Ensure a session ID exists. If the SW just restarted and sessionId is empty,
 * wait for the storage restoration to complete before deciding whether to
 * generate a new one. This prevents each post-restart ping from using a
 * different sessionId, which would reset the backend reference window.
 */
async function ensureSession(): Promise<void> {
  if (sessionId) return; // already have one in memory

  // Wait for storage restoration to complete (fires once on SW startup)
  await sessionIdRestored;

  if (!sessionId) {
    // Storage didn't have one either — generate fresh
    sessionId = generateSessionId();
    sessionInvalidated = false; // new session — beacon cycle starts clean
    chrome.storage.local.set({ browserguard_sessionId: sessionId });
    console.info('[BrowserGuard] Generated new sessionId:', sessionId);
  } else {
    console.info('[BrowserGuard] Restored sessionId from storage:', sessionId);
  }
}

// ─── Device context ─────────────────────────────────────────────────
// Service workers have no window/document/DOM. Viewport dimensions are
// captured by the content script (which runs in the page context) and
// passed in the behavior snapshot. We use those values if available,
// otherwise fall back to defaults.

function getDeviceContext(snap?: BehaviorSnapshot) {
  return {
    viewportWidth: snap?.viewportWidth ?? 1920,
    viewportHeight: snap?.viewportHeight ?? 1080,
    pixelRatio: snap?.pixelRatio ?? 1,
    platform: 'desktop' as const,
  };
}

// ─── Build snapshot for backend ─────────────────────────────────────

export function buildBackendSnapshot(snap: BehaviorSnapshot) {
  const keystrokeIntervalStats = computeStats(snap.keystrokeIntervals);
  const keystrokeHoldStats = computeStats(snap.keystrokeHolds);
  const mouseSpeedStats = computeStats(snap.mouseSpeeds);
  const mouseCurvatureStats = computeStats(snap.mouseCurvatures);
  const scrollSpeedStats = computeStats(snap.scrollSpeeds);

  return {
    keystrokeIntervalAvg: keystrokeIntervalStats.avg,
    keystrokeHoldAvg: keystrokeHoldStats.avg,
    keystrokeVariance: keystrokeIntervalStats.variance,
    keystrokeCount: snap.keystrokeCount,
    mouseSpeedAvg: mouseSpeedStats.avg,
    mouseCurvatureAvg: mouseCurvatureStats.avg,
    mousePauseCount: snap.mousePauseCount,
    mouseEventCount: snap.mouseEventCount,
    scrollSpeedAvg: scrollSpeedStats.avg,
    scrollPauseCount: snap.scrollPauseCount,
    scrollEventCount: snap.scrollEventCount,
    totalEvents: snap.totalEvents,
    timestamp: snap.timestamp,
  };
}

export function computeStats(arr: number[]): { avg: number | null; variance: number | null } {
  if (arr.length === 0) return { avg: null, variance: null };
  const avg = arr.reduce((s, v) => s + v, 0) / arr.length;
  const variance = arr.reduce((s, v) => s + (v - avg) ** 2, 0) / arr.length;
  return { avg, variance };
}

// ─── Beacon to backend ──────────────────────────────────────────────

export async function sendBeacon(): Promise<void> {
  if (!lastSnapshot || lastSnapshot.totalEvents === 0) {
    console.debug('[BrowserGuard] Beacon skipped: no snapshot or zero events');
    return;
  }
  if (stepUpInProgress) {
    console.debug('[BrowserGuard] Beacon skipped: step-up in progress');
    return;
  }
  if (sessionInvalidated) {
    // The current session has been invalidated by the backend. There is no
    // point continuing to beacon — the session is closed server-side. The
    // beacon timer has already been stopped (see the invalidated handling
    // below); this guard catches any stray beacon call (e.g. a manual
    // triggerBeacon from the DevTools console). A new session (new sessionId
    // via ensureSession) resets this flag and restarts the cycle.
    console.debug('[BrowserGuard] Beacon skipped: session invalidated');
    return;
  }

  await ensureSession();

  const body = {
    sessionId,
    source: 'browserguard' as const,
    snapshot: buildBackendSnapshot(lastSnapshot),
    deviceContext: getDeviceContext(lastSnapshot),
  };

  try {
    const resp = await fetch(BACKEND_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Source-App': 'browserguard',
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      console.error('[BrowserGuard] Beacon failed:', resp.status);
      return;
    }

    const data: BackendResponse = await resp.json();
    console.info('[BrowserGuard] Beacon response:', JSON.stringify({
      step_up_required: data.step_up_required,
      step_up_url: data.step_up_url,
      trust_score_normalized: data.trust_score_normalized,
      referenceWindowActive: data.referenceWindowActive,
      invalidated: data.invalidated,
      stepUpInProgress,
    }));

    // ── Session invalidation: stop beaconing silently ──
    // The backend has closed this session (behavioral divergence, mass
    // attempts, step-up fail-closed, etc.). There is no point continuing
    // to beacon — stop the timer and mark the session as invalidated so
    // future sendBeacon calls skip immediately. No UI, no popup, no user-
    // visible effect — the extension just goes quiet for this session.
    // A new session (new sessionId via ensureSession) resets the flag and
    // restarts the beacon cycle.
    if (data.invalidated === true) {
      sessionInvalidated = true;
      if (beaconTimer) {
        clearInterval(beaconTimer);
        beaconTimer = null;
      }
      console.info('[BrowserGuard] Session invalidated by backend — beacon cycle stopped for this session');
      // Do NOT trigger step-up even if step_up_required is also true —
      // an invalidated session is already closed, step-up is meaningless.
      return;
    }

    // Check for step-up requirement
    if (data.step_up_required === true && data.step_up_url && !stepUpInProgress) {
      console.info('[BrowserGuard] Step-up required, triggering popup');
      triggerStepUp(data.step_up_url);
    } else if (data.step_up_required === true && !data.step_up_url) {
      console.warn('[BrowserGuard] Step-up required but no step_up_url in response');
    } else if (data.step_up_required === true && stepUpInProgress) {
      console.debug('[BrowserGuard] Step-up required but already in progress, skipping');
    }
  } catch (err) {
    console.error('[BrowserGuard] Beacon error:', err);
  }
}

// ─── Debug exposure ─────────────────────────────────────────────────
// Expose sendBeacon and key state on globalThis for manual testing from
// the DevTools service worker console. This allows calling the REAL
// sendBeacon() (which processes the response and triggers step-up)
// instead of a raw fetch() that bypasses the step-up logic.
//
// Usage in SW DevTools console:
//   browserguard.test.triggerBeacon()        — calls sendBeacon() with current lastSnapshot
//   browserguard.test.setSnapshot({...})     — set a fake snapshot for testing
//   browserguard.test.resetStepUp()          — force-reset stepUpInProgress
//   browserguard.test.state()                — dump current state
if (isServiceWorkerContext) {
(self as any).browserguard = {
  test: {
    triggerBeacon: () => sendBeacon(),
    setSnapshot: (snap: BehaviorSnapshot) => {
      // Validate required array fields — computeStats() crashes with a cryptic
      // "Cannot read properties of undefined (reading 'length')" if these are
      // missing or wrong type (e.g. passing *Avg numbers instead of arrays).
      const arrayFields: (keyof BehaviorSnapshot)[] = [
        'keystrokeIntervals', 'keystrokeHolds', 'mouseSpeeds',
        'mouseCurvatures', 'scrollSpeeds',
      ];
      for (const field of arrayFields) {
        const val = (snap as any)[field];
        if (!Array.isArray(val)) {
          throw new Error(
            `setSnapshot: field "${field}" must be a number[] (got ${typeof val}). ` +
            'Pass raw arrays, not pre-aggregated *Avg values. ' +
            'Example: keystrokeIntervals: [180, 175, 185, ...] not keystrokeIntervalAvg: 180.'
          );
        }
      }
      if (typeof snap.totalEvents !== 'number' || snap.totalEvents === 0) {
        throw new Error('setSnapshot: totalEvents must be a non-zero number (sendBeacon skips zero-event snapshots)');
      }
      lastSnapshot = snap;
      console.info('[BrowserGuard] Snapshot set:', {
        totalEvents: snap.totalEvents,
        keystrokeIntervals: snap.keystrokeIntervals.length,
        mouseSpeeds: snap.mouseSpeeds.length,
        scrollSpeeds: snap.scrollSpeeds.length,
      });
    },
    resetStepUp: () => {
      stepUpInProgress = false;
      stepUpWindowId = null;
      if (stepUpSafetyTimer) { clearTimeout(stepUpSafetyTimer); stepUpSafetyTimer = null; }
      console.info('[BrowserGuard] stepUpInProgress force-reset');
    },
    state: () => ({
      sessionId,
      stepUpInProgress,
      stepUpWindowId,
      hasSnapshot: !!lastSnapshot,
      snapshotEvents: lastSnapshot?.totalEvents ?? 0,
      autoBeaconPaused,
    }),
    pauseAutoBeacon: () => {
      if (beaconTimer) {
        clearInterval(beaconTimer);
        beaconTimer = null;
      }
      autoBeaconPaused = true;
      console.info('[BrowserGuard] Auto beacon paused — manual testing mode active');
    },
    resumeAutoBeacon: () => {
      if (!beaconTimer) {
        beaconTimer = setInterval(sendBeacon, BEACON_INTERVAL_MS);
      }
      autoBeaconPaused = false;
      console.info('[BrowserGuard] Auto beacon resumed');
    },
  },
};
} // end isServiceWorkerContext guard for debug exposure

// ─── Step-up trigger ────────────────────────────────────────────────

export function triggerStepUp(stepUpUrl: string): void {
  console.info('[BrowserGuard] triggerStepUp called, stepUpUrl=', stepUpUrl);

  // Guard against duplicate popups: if a step-up is already in progress,
  // do NOT open a second popup. The existing popup is still active (the
  // user may be answering the challenge). Opening a second one would
  // overwrite stepUpWindowId, losing the reference to the first window —
  // when the first window closes, onStepUpWindowRemoved would not match
  // (stepUpWindowId now points to the second window) and the cleanup
  // would be silently skipped, leaving an orphan popup open.
  if (stepUpInProgress) {
    console.info('[BrowserGuard] Step-up already in progress, ignoring duplicate triggerStepUp call');
    return;
  }

  stepUpInProgress = true;

  // Build the step-up.html URL with query params
  const extensionUrl = chrome.runtime.getURL('src/step-up.html');
  const params = new URLSearchParams({
    sessionId,
    tenantId,
    callbackOrigin: `chrome-extension://${chrome.runtime.id}`,
    stepUpUrl,
  });

  const fullUrl = `${extensionUrl}?${params.toString()}`;
  console.info('[BrowserGuard] Opening step-up popup:', fullUrl);

  // Safety timer: force-reset stepUpInProgress after 90s regardless of
  // whether a result/error message was received. This prevents the flag
  // from being stuck at true forever if the popup is closed manually,
  // the SW is killed by MV3, or the iframe fails silently.
  if (stepUpSafetyTimer) clearTimeout(stepUpSafetyTimer);
  stepUpSafetyTimer = setTimeout(() => {
    if (stepUpInProgress) {
      console.warn('[BrowserGuard] Step-up safety timeout — force-resetting stepUpInProgress');
      // Notify backend so cooldown is set (prevents re-trigger loop)
      notifyStepUpEnd(sessionId, false, 'SAFETY_TIMEOUT', 0, 0);
      stepUpInProgress = false;
      stepUpWindowId = null;
    }
  }, STEP_UP_SAFETY_TIMEOUT_MS);

  // Open as a popup window — zero friction, auto-closes after result.
  // Center the popup over the user's last-focused window so it's immediately
  // visible (critical for the 0.7s digit display in stroop_digitspan_combo).
  const popupWidth = 480;
  const popupHeight = 400;

  chrome.windows.getLastFocused((currentWindow) => {
    const winLeft = currentWindow?.left ?? 0;
    const winTop = currentWindow?.top ?? 0;
    const winWidth = currentWindow?.width ?? popupWidth;
    const winHeight = currentWindow?.height ?? popupHeight;

    const left = Math.round(winLeft + (winWidth - popupWidth) / 2);
    const top = Math.round(winTop + (winHeight - popupHeight) / 2);

    chrome.windows.create({
      url: fullUrl,
      type: 'popup',
      width: popupWidth,
      height: popupHeight,
      left,
      top,
      focused: true,
    }, (window) => {
      if (chrome.runtime.lastError) {
        console.error('[BrowserGuard] Failed to open step-up window:', chrome.runtime.lastError);
        stepUpInProgress = false;
        stepUpWindowId = null;
        if (stepUpSafetyTimer) clearTimeout(stepUpSafetyTimer);
        return;
      }
      if (window) {
        stepUpWindowId = window.id ?? null;
        console.info('[BrowserGuard] Step-up popup opened, windowId=', window.id);
      }
    });
  });
}

// ─── Step-up popup close listener ───────────────────────────────────
// If the popup is closed (manually, by timeout, or by crash), reset
// stepUpInProgress so future beacons can trigger a new step-up.
export function onStepUpWindowRemoved(windowId: number): void {
  if (windowId === stepUpWindowId) {
    console.info('[BrowserGuard] Step-up popup closed, windowId=', windowId);
    // Only notify if we haven't already (handleStepUpResult or error handler
    // may have already notified + cleared stepUpWindowId). If stepUpInProgress
    // is still true, it means the popup was closed without a result/error —
    // notify backend so cooldown is set.
    if (stepUpInProgress) {
      notifyStepUpEnd(sessionId, false, 'POPUP_CLOSED', 0, 0);
    }
    stepUpInProgress = false;
    stepUpWindowId = null;
    if (stepUpSafetyTimer) {
      clearTimeout(stepUpSafetyTimer);
      stepUpSafetyTimer = null;
    }
  }
}

if (isServiceWorkerContext) {
  chrome.windows.onRemoved.addListener(onStepUpWindowRemoved);
}

// ─── Notify backend of step-up end (always, even on error/timeout) ───
// This is critical for the cooldown mechanism: the backend sets a cooldown
// in /step-up-result. If we only call it on success, errors/timeouts never
// set a cooldown and the popup re-opens in an infinite loop.
export async function notifyStepUpEnd(sessionId: string, success: boolean, decision: string, score: number, confidence: number): Promise<void> {
  try {
    await fetch(`${BACKEND_URL.replace('/session-behavior-ping', '/step-up-result')}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Source-App': 'browserguard',
      },
      body: JSON.stringify({ sessionId, stepUpSuccess: success, decision, score, confidence }),
    });
    console.info(`[BrowserGuard] Step-up end notified to backend: success=${success} decision=${decision}`);
  } catch (err) {
    console.error('[BrowserGuard] Failed to notify backend of step-up end:', err);
  }
}

// ─── Step-up result handling ────────────────────────────────────────

export function isStepUpSuccess(result: StepUpResultMessage): boolean {
  // Decision logic (validated):
  //   GO → success
  //   INSUFFICIENT_CONFIDENCE + score >= 60 → success
  //   NO-GO → failure
  if (result.decision === 'GO') return true;
  if (result.decision === 'INSUFFICIENT_CONFIDENCE' && result.score >= 60) return true;
  return false;
}

export async function handleStepUpResult(result: StepUpResultMessage): Promise<void> {
  console.info('[BrowserGuard] Step-up result received:', result.decision, 'score=', result.score);
  const success = isStepUpSuccess(result);

  // IMPORTANT: use the BrowserGuard sessionId (closure variable `sessionId`),
  // NOT result.sessionId. The popup relays currentSession.sessionId from the
  // GateGuard embed iframe (embed.js:351), which is the GateGuard-internal
  // session ID returned by /session/start — a different identifier than the
  // BrowserGuard behavioral session ID used for Redis keys, beacons, and
  // cooldown. Using result.sessionId here would write the cooldown and the
  // emaDivergence reset under an orphan Redis key (browserguard:behavior:session:<gg_...>)
  // that the beacons never read, making the cooldown and the state repair
  // completely inoperative (re-trigger loop on every ping, even after a GO).
  await notifyStepUpEnd(sessionId, success, result.decision, result.score, result.confidence);

  stepUpInProgress = false;
  stepUpWindowId = null;
  if (stepUpSafetyTimer) {
    clearTimeout(stepUpSafetyTimer);
    stepUpSafetyTimer = null;
  }
}

// ─── Message listener ───────────────────────────────────────────────

export function onRuntimeMessage(message: any, _sender: any, _sendResponse: any): boolean {
  if (message.type === 'browserguard_behavior_snapshot') {
    lastSnapshot = message.snapshot as BehaviorSnapshot;
    return false; // synchronous, no response needed
  }

  if (message.type === 'browserguard_stepup_result') {
    handleStepUpResult(message as StepUpResultMessage);
    return false;
  }

  if (message.type === 'browserguard_stepup_error') {
    const errMsg = message as StepUpErrorMessage;
    console.error('[BrowserGuard] Step-up error:', errMsg.error, errMsg.detail);
    // Notify backend so it sets a cooldown — otherwise the popup re-opens
    // in an infinite loop because no cooldown is ever stored.
    // Use the BrowserGuard sessionId (closure variable), NOT errMsg.sessionId
    // (which comes from GateGuard's embed.js:408 and is the GateGuard-internal
    // session ID, not the BrowserGuard behavioral session ID). See
    // handleStepUpResult above for the full rationale.
    notifyStepUpEnd(sessionId, false, 'ERROR', 0, 0);
    stepUpInProgress = false;
    stepUpWindowId = null;
    if (stepUpSafetyTimer) {
      clearTimeout(stepUpSafetyTimer);
      stepUpSafetyTimer = null;
    }
    return false;
  }

  return false;
}

if (isServiceWorkerContext) {
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
}

// ─── Test helpers (exported, no runtime effect in production SW) ────
// These let tests inspect and mutate the module-level state that the
// service worker functions operate on. In production, esbuild strips the
// `export` keywords (each entry point is bundled independently), so these
// are not accessible from other entry points.
export function __testGetState() {
  return {
    sessionId,
    stepUpInProgress,
    stepUpWindowId,
    hasSnapshot: !!lastSnapshot,
    snapshotEvents: lastSnapshot?.totalEvents ?? 0,
    autoBeaconPaused,
    sessionInvalidated,
  };
}

export function __testSetSessionId(id: string): void {
  sessionId = id;
  // Reset invalidation flag when session changes — a new session starts
  // with a clean beacon cycle, mirroring ensureSession() behavior.
  sessionInvalidated = false;
}

export function __testSetSnapshot(snap: BehaviorSnapshot | null): void {
  lastSnapshot = snap;
}

export function __testResetStepUp(): void {
  stepUpInProgress = false;
  stepUpWindowId = null;
  sessionInvalidated = false;
  if (stepUpSafetyTimer) { clearTimeout(stepUpSafetyTimer); stepUpSafetyTimer = null; }
}

// ─── Lifecycle ──────────────────────────────────────────────────────

// Restore session ID from storage on startup.
// The promise resolves when the callback fires, allowing ensureSession()
// to wait for it before generating a new ID (fixes the race condition
// where a post-restart ping would get a new sessionId before the
// persisted one was loaded).
if (isServiceWorkerContext) {
  sessionIdRestored = new Promise<void>((resolve) => {
    chrome.storage.local.get(['browserguard_sessionId'], (result) => {
      if (result.browserguard_sessionId) {
        sessionId = result.browserguard_sessionId;
        console.info('[BrowserGuard] Session ID restored from storage:', sessionId);
      }
      resolve();
    });
  });

  // Start periodic beacon
  beaconTimer = setInterval(sendBeacon, BEACON_INTERVAL_MS);

  // Clean up on suspend (MV3 service workers can be killed)
  self.addEventListener('beforeunload', () => {
    console.info('[BrowserGuard] Service worker suspending — state will be lost');
    if (beaconTimer) clearInterval(beaconTimer);
    if (stepUpSafetyTimer) clearTimeout(stepUpSafetyTimer);
  });
} else {
  // In tests (or any non-SW context), resolve immediately so ensureSession()
  // doesn't hang waiting for a storage callback that will never fire.
  sessionIdRestored = Promise.resolve();
}
