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
 * @copyright (c) 2026 Benjamin BARRERE / IA SOLUTION
 * @license Patents Pending FR2514274 | FR2514546
 */

export {}; // make this a module (service workers have no imports)

// ─── Config ─────────────────────────────────────────────────────────

const BEACON_INTERVAL_MS = 5_000; // ≥5s to stay under 20 req/min Worker rate limit
const BACKEND_URL = 'https://api.hcs-u7.org/hv/api/browserguard/session-behavior-ping';
const STEP_UP_URL_BASE = 'https://challenge.hcs-u7.org/embed/';

// ─── Types ──────────────────────────────────────────────────────────

interface BehaviorSnapshot {
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

interface BackendResponse {
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

interface StepUpResultMessage {
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

interface StepUpErrorMessage {
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

// Safety timeout: if no result/error is received within 90s, force-reset
// stepUpInProgress so future beacons can trigger a new step-up.
// 90s > 60s (step-up.ts timeout) to let the normal close flow happen first.
const STEP_UP_SAFETY_TIMEOUT_MS = 90_000;

// ─── Session ID generation ──────────────────────────────────────────

function generateSessionId(): string {
  return `bg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function ensureSession(): void {
  if (!sessionId) {
    sessionId = generateSessionId();
    chrome.storage.local.set({ browserguard_sessionId: sessionId });
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

function buildBackendSnapshot(snap: BehaviorSnapshot) {
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

function computeStats(arr: number[]): { avg: number | null; variance: number | null } {
  if (arr.length === 0) return { avg: null, variance: null };
  const avg = arr.reduce((s, v) => s + v, 0) / arr.length;
  const variance = arr.reduce((s, v) => s + (v - avg) ** 2, 0) / arr.length;
  return { avg, variance };
}

// ─── Beacon to backend ──────────────────────────────────────────────

async function sendBeacon(): Promise<void> {
  if (!lastSnapshot || lastSnapshot.totalEvents === 0) {
    console.debug('[BrowserGuard] Beacon skipped: no snapshot or zero events');
    return;
  }
  if (stepUpInProgress) {
    console.debug('[BrowserGuard] Beacon skipped: step-up in progress');
    return;
  }

  ensureSession();

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
    }),
  },
};

// ─── Step-up trigger ────────────────────────────────────────────────

function triggerStepUp(stepUpUrl: string): void {
  console.info('[BrowserGuard] triggerStepUp called, stepUpUrl=', stepUpUrl);
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
      stepUpInProgress = false;
      stepUpWindowId = null;
    }
  }, STEP_UP_SAFETY_TIMEOUT_MS);

  // Open as a popup window — zero friction, auto-closes after result
  chrome.windows.create({
    url: fullUrl,
    type: 'popup',
    width: 480,
    height: 400,
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
}

// ─── Step-up popup close listener ───────────────────────────────────
// If the popup is closed (manually, by timeout, or by crash), reset
// stepUpInProgress so future beacons can trigger a new step-up.
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === stepUpWindowId) {
    console.info('[BrowserGuard] Step-up popup closed, windowId=', windowId);
    stepUpInProgress = false;
    stepUpWindowId = null;
    if (stepUpSafetyTimer) {
      clearTimeout(stepUpSafetyTimer);
      stepUpSafetyTimer = null;
    }
  }
});

// ─── Step-up result handling ────────────────────────────────────────

function isStepUpSuccess(result: StepUpResultMessage): boolean {
  // Decision logic (validated):
  //   GO → success
  //   INSUFFICIENT_CONFIDENCE + score >= 60 → success
  //   NO-GO → failure
  if (result.decision === 'GO') return true;
  if (result.decision === 'INSUFFICIENT_CONFIDENCE' && result.score >= 60) return true;
  return false;
}

async function handleStepUpResult(result: StepUpResultMessage): Promise<void> {
  console.info('[BrowserGuard] Step-up result received:', result.decision, 'score=', result.score);
  const success = isStepUpSuccess(result);

  // Notify backend of the step-up result
  try {
    await fetch(`${BACKEND_URL.replace('/session-behavior-ping', '/step-up-result')}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Source-App': 'browserguard',
      },
      body: JSON.stringify({
        sessionId: result.sessionId,
        stepUpSuccess: success,
        decision: result.decision,
        score: result.score,
        confidence: result.confidence,
      }),
    });
    console.info('[BrowserGuard] Step-up result notified to backend, success=', success);
  } catch (err) {
    console.error('[BrowserGuard] Failed to notify backend of step-up result:', err);
  }

  stepUpInProgress = false;
  stepUpWindowId = null;
  if (stepUpSafetyTimer) {
    clearTimeout(stepUpSafetyTimer);
    stepUpSafetyTimer = null;
  }
}

// ─── Message listener ───────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, _sender, _sendResponse) => {
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
    stepUpInProgress = false;
    stepUpWindowId = null;
    if (stepUpSafetyTimer) {
      clearTimeout(stepUpSafetyTimer);
      stepUpSafetyTimer = null;
    }
    return false;
  }

  return false;
});

// ─── Lifecycle ──────────────────────────────────────────────────────

// Restore session ID from storage on startup
chrome.storage.local.get(['browserguard_sessionId'], (result) => {
  if (result.browserguard_sessionId) {
    sessionId = result.browserguard_sessionId;
  }
});

// Start periodic beacon
beaconTimer = setInterval(sendBeacon, BEACON_INTERVAL_MS);

// Clean up on suspend (MV3 service workers can be killed)
self.addEventListener('beforeunload', () => {
  console.info('[BrowserGuard] Service worker suspending — state will be lost');
  if (beaconTimer) clearInterval(beaconTimer);
  if (stepUpSafetyTimer) clearTimeout(stepUpSafetyTimer);
});
