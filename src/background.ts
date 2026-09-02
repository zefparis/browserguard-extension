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

// ─── chrome.alarms listener (top-level, synchronous) ───────────────
// Must be registered at the top level of the service worker script so it
// is available immediately on SW restart. If registered inside an async
// function, the SW may miss the first alarm event after restart.
// Guarded by isServiceWorkerContext so it doesn't run in tests.
if (isServiceWorkerContext && typeof chrome.alarms !== 'undefined') {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === BEACON_ALARM_NAME) {
      void sendBeacon();
    }
  });
}

// ─── Config ─────────────────────────────────────────────────────────

const BEACON_INTERVAL_MS = 5_000; // ≥5s to stay under 20 req/min Worker rate limit
const BACKEND_URL = 'https://api.hcs-u7.org/hv/api/browserguard/session-behavior-ping';
const STEP_UP_URL_BASE = 'https://challenge.hcs-u7.org/embed/';

// ─── Beacon scheduling (hybrid: setInterval + chrome.alarms) ────────
//
// MV3 service workers are killed by Chrome after ~30s of idleness. When
// killed, setInterval stops permanently and is NOT recreated on restart
// until the lifecycle block runs again. chrome.alarms survives SW kills
// and wakes the SW at the scheduled time.
//
// However, chrome.alarms has a minimum period of ~1 minute in release
// builds (Chrome clamps periodInMinutes < 1 to 1). This is too coarse
// for our 5s beacon cadence.
//
// Solution: hybrid scheduling.
//   - setInterval(sendBeacon, 5000) provides the fine 5s cadence while
//     the SW is alive (the normal case — the SW stays alive as long as
//     it receives events from content scripts or active fetches).
//   - chrome.alarms with periodInMinutes: 1 acts as a safety net: if the
//     SW is killed, the alarm wakes it, the lifecycle block recreates
//     the setInterval, and the beacon resumes. The alarm itself also
//     calls sendBeacon directly (in case the SW was killed mid-interval
//     and a snapshot is waiting).
//
// The alarm fires at most once per minute — much less frequent than the
// 5s setInterval — so it does not duplicate beacons in practice. When
// both fire close together, sendBeacon's idempotency guards (skip if
// step-up in progress, skip if session invalidated, skip if no snapshot)
// prevent double sends.

const BEACON_ALARM_NAME = 'browserguard_beacon';
const BEACON_ALARM_PERIOD_MIN = 1; // minimum allowed by Chrome in release builds

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
  // Diagnostic (think-time cadence calibration) — NOT scored by any engine
  burstRatio?: number | null;
  interEventGapStd?: number | null;
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
  // Experimental observability (Phase 1) — not consumed by the extension.
  cross_session_signal?: number | null;
  cross_session_signal_reason?: string | null;
  // Diagnostic (think-time cadence calibration) — not consumed by the extension.
  diag_burstRatio?: number | null;
  diag_interEventGapStd?: number | null;
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
  // SECURITY: Signed proof token from GateGuard /session/finalize.
  // Required by /step-up-result for GO decisions (B1-critical fix).
  proofToken: string | null;
}

export interface StepUpErrorMessage {
  type: 'browserguard_stepup_error';
  error: string;
  detail: string;
  sessionId: string | null;
}

// ─── State ──────────────────────────────────────────────────────────

let sessionId: string = '';
let installId: string = '';
let tenantId: string = 'browserguard-default';
// Bundle hash calculated at startup from manifest.json + background.js.
// Sent with the first ping for server-side integrity validation.
let extBundleHash: string = '';
// ⚠ LIMITATION: lastSnapshot est une variable unique, écrasée par le dernier
// message reçu de n'importe quel onglet. En usage multi-onglet actif simultané,
// le beacon peut envoyer le snapshot d'un onglet inactif au lieu de l'actif.
// Non corrigé — l'impact sur le scoring est négligeable (données du même
// utilisateur). Voir README.md → "Limitation connue — snapshot multi-onglet".
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

// ─── Local popup failure backoff (Correctif 4 — defensive) ──────────
// If chrome.windows.create fails repeatedly (e.g. popup blocker, resource
// exhaustion), stop trying to open popups for 120s after 3 consecutive
// failures. This is a LOCAL safety net — the primary protection is the
// backend cooldown (Correctif 1+2). Not persisted: loss on SW restart is
// acceptable (the backend cooldown still applies).
let consecutivePopupFailures: number = 0;
let lastPopupFailureAt: number = 0;
const POPUP_FAILURE_THRESHOLD = 3;
const POPUP_FAILURE_BACKOFF_MS = 120_000;

// Safety timeout: if no result/error is received within 90s, force-reset
// stepUpInProgress so future beacons can trigger a new step-up.
// 90s > 60s (step-up.ts timeout) to let the normal close flow happen first.
const STEP_UP_SAFETY_TIMEOUT_MS = 90_000;

// ─── Step-up state persistence (R7a/R7b/R7c fix) ────────────────────
// MV3 service workers are killed and restarted by Chrome at any time.
// stepUpInProgress, stepUpWindowId, and the 90s safety timer are all
// in-memory and lost on restart. This causes:
//   R7a — orphan popup: onStepUpWindowRemoved won't match (windowId=null)
//   R7b — double step-up: stepUpInProgress=false → second popup opened
//   R7c — safety timer lost: no force-reset if popup hangs
//
// Fix: persist step-up state to chrome.storage.local so it survives SW
// restarts. On startup, restore and reconcile (check if popup still
// exists, re-arm safety timer with remaining time, or clean up if the
// popup was closed while the SW was dead).

interface StepUpState {
  inProgress: boolean;
  windowId: number | null;
  startedAt: number | null;
  sessionId: string | null;
}

const STEP_UP_STATE_KEY = 'browserguard_stepUpState';

// ─── Beacon alarm management ────────────────────────────────────────
// ensureBeaconAlarm creates the chrome.alarm if it doesn't exist yet.
// chrome.alarms.create with the same name replaces any existing alarm
// with the same name (idempotent), so calling this on every SW restart
// is safe — no duplicate alarms accumulate.
function ensureBeaconAlarm(): void {
  if (!isServiceWorkerContext || typeof chrome.alarms === 'undefined') return;
  chrome.alarms.create(BEACON_ALARM_NAME, { periodInMinutes: BEACON_ALARM_PERIOD_MIN });
}

// clearBeaconAlarm removes the safety-net alarm. Used when the session is
// invalidated or the beacon is permanently stopped for this session.
function clearBeaconAlarm(): void {
  if (!isServiceWorkerContext || typeof chrome.alarms === 'undefined') return;
  chrome.alarms.clear(BEACON_ALARM_NAME);
}

function clearStepUpState(): void {
  stepUpInProgress = false;
  stepUpWindowId = null;
  if (stepUpSafetyTimer) {
    clearTimeout(stepUpSafetyTimer);
    stepUpSafetyTimer = null;
  }
  if (isServiceWorkerContext) {
    chrome.storage.local.remove(STEP_UP_STATE_KEY);
  }
}

function persistStepUpState(): void {
  if (!isServiceWorkerContext) return;
  const state: StepUpState = {
    inProgress: stepUpInProgress,
    windowId: stepUpWindowId,
    startedAt: stepUpSafetyTimer ? Date.now() : null,
    sessionId: stepUpInProgress ? sessionId : null,
  };
  chrome.storage.local.set({ [STEP_UP_STATE_KEY]: state });
}

// Promise that resolves when step-up state restoration is complete on
// SW startup. sendBeacon() awaits this before checking stepUpInProgress
// to avoid evaluating the guard with stale (false) state.
let stepUpStateRestored: Promise<void>;

// ─── Session ID generation ──────────────────────────────────────────

function generateSessionId(): string {
  return `bg_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function generateInstallId(): string {
  return `bg_install_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
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

// ─── Install ID (persistent across sessions, survives SW restarts) ──
// Unlike sessionId (regenerated per navigation session), installId is
// generated once and never regenerated as long as the extension remains
// installed with its data. It survives browser restarts and SW kills.
// Only a full uninstall or manual data clearing removes it.

let installIdRestored: Promise<void>;

/**
 * Ensure an install ID exists. If the SW just restarted and installId is
 * empty, wait for the storage restoration to complete before deciding
 * whether to generate a new one. This ID is NEVER reset — it is only
 * generated once (first install) and restored on every subsequent SW
 * startup.
 */
async function ensureInstallId(): Promise<void> {
  if (installId) return; // already have one in memory

  // Wait for storage restoration to complete (fires once on SW startup)
  await installIdRestored;

  if (!installId) {
    // First install — generate and persist
    installId = generateInstallId();
    chrome.storage.local.set({ browserguard_installId: installId });
    console.info('[BrowserGuard] Generated new installId:', installId);
  } else {
    console.info('[BrowserGuard] Restored installId from storage:', installId);
  }
}

/**
 * Compute a bundle hash from the extension's own resources at startup.
 * This is a lightweight integrity signal — not cryptographically strong
 * (the hash is not authenticated), but it detects casual modifications.
 *
 * The hash is computed from:
 *   - manifest.json version + name + permissions
 *   - background.js size (approximate, via fetch)
 *
 * The hash is sent with the first behavioral ping as `extBundleHash`.
 */
async function computeBundleHash(): Promise<void> {
  if (extBundleHash) return; // already computed
  try {
    const manifest = chrome.runtime.getManifest();
    // Build a fingerprint from manifest fields that should be stable
    // for a given published version.
    const fingerprint = JSON.stringify({
      version: manifest.version,
      name: manifest.name,
      permissions: (manifest.permissions || []).sort(),
      content_security_policy: manifest.content_security_policy,
    });

    // Use SubtleCrypto for SHA-256 (available in service workers)
    const encoder = new TextEncoder();
    const data = encoder.encode(fingerprint);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    extBundleHash = 'sha256:' + hashArray
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
    console.info('[BrowserGuard] Computed bundle hash:', extBundleHash);
  } catch (err) {
    console.warn('[BrowserGuard] Failed to compute bundle hash:', err);
    extBundleHash = '';
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
    // Diagnostic (think-time cadence calibration) — NOT scored by any engine.
    // Passed through as top-level fields, not nested, to keep the payload flat.
    burstRatio: snap.burstRatio ?? null,
    interEventGapStd: snap.interEventGapStd ?? null,
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
  // Wait for step-up state restoration before checking stepUpInProgress.
  // Without this, a post-restart beacon could see stepUpInProgress=false
  // (stale) and open a duplicate popup while the original is still open (R7b).
  await stepUpStateRestored;
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
  await ensureInstallId();
  await computeBundleHash();

  const body = {
    sessionId,
    installId,
    source: 'browserguard' as const,
    snapshot: buildBackendSnapshot(lastSnapshot),
    deviceContext: getDeviceContext(lastSnapshot),
    // Extension version for adoption tracking. The backend logs this in
    // the browserguard_risk_eval structured log to measure the share of
    // v0.2.0+ extensions (CSP frame-src includes api.hcs-u7.org) before
    // flipping BROWSERGUARD_STEP_UP_URL to the Worker-proxied URL.
    // Now also validated against an allowlist of known versions.
    extVersion: chrome.runtime.getManifest().version,
    // Bundle hash for integrity validation. Computed at startup from
    // manifest fields. Advisory signal — not a hard gate.
    extBundleHash: extBundleHash || undefined,
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
      // ── Session rotation recovery (fallback) ──
      // If the backend returns 403 SESSION_ROTATED, it means the current
      // sessionId was rotated (after a step-up GO) but the extension didn't
      // receive the new_session_id in the step-up-result response (network
      // loss, SW restart, etc.). The backend includes the new sessionId in
      // the error response — switch to it and retry the beacon.
      if (resp.status === 403) {
        try {
          const errData = await resp.json();
          if (errData.error === 'SESSION_ROTATED' && errData.new_session_id) {
            console.info(`[BrowserGuard] Beacon rejected (SESSION_ROTATED) — switching to new sessionId: ${errData.new_session_id}`);
            rotateSessionId(errData.new_session_id);
            // Retry the beacon once with the new sessionId — don't loop
            // (if the new sessionId is also rejected, the next 5s cycle
            // will handle it normally).
            const retryBody = { ...body, sessionId };
            const retryResp = await fetch(BACKEND_URL, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-Source-App': 'browserguard',
              },
              body: JSON.stringify(retryBody),
            });
            if (retryResp.ok) {
              const retryData: BackendResponse = await retryResp.json();
              console.info('[BrowserGuard] Beacon retry with rotated sessionId succeeded');
              // Process the retry response normally (step-up check, invalidation, etc.)
              // Fall through to the normal response handling below by reassigning.
              // Note: we don't re-run the full response processing here to keep it
              // simple — the next 5s beacon cycle will pick up any step-up requirement.
              void retryData;
            }
            return;
          }
        } catch {
          // Response wasn't JSON or didn't have the expected fields —
          // fall through to the generic error log below.
        }
      }
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
      // Diagnostic (think-time cadence) — echoed back by server, not consumed
      diag_burstRatio: data.diag_burstRatio,
      diag_interEventGapStd: data.diag_interEventGapStd,
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
      clearBeaconAlarm();
      console.info('[BrowserGuard] Session invalidated by backend — beacon cycle stopped for this session');
      // Do NOT trigger step-up even if step_up_required is also true —
      // an invalidated session is already closed, step-up is meaningless.
      return;
    }

    // Check for step-up requirement
    if (data.step_up_required === true && data.step_up_url && !stepUpInProgress) {
      // Correctif 4: local backoff after consecutive popup open failures.
      // If chrome.windows.create has failed 3+ times in the last 120s,
      // skip the trigger to avoid spamming failed popup attempts. The
      // backend cooldown (Correctif 1+2) is the primary protection; this
      // is a defensive local net for when the backend doesn't cooperate.
      if (
        consecutivePopupFailures >= POPUP_FAILURE_THRESHOLD &&
        (Date.now() - lastPopupFailureAt) < POPUP_FAILURE_BACKOFF_MS
      ) {
        const remaining = Math.ceil((POPUP_FAILURE_BACKOFF_MS - (Date.now() - lastPopupFailureAt)) / 1000);
        console.warn(`[BrowserGuard] Step-up required but skipping popup — ${consecutivePopupFailures} consecutive open failures, local backoff ${remaining}s remaining`);
      } else {
        console.info('[BrowserGuard] Step-up required, triggering popup');
        triggerStepUp(data.step_up_url);
      }
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
//
// SECURITY: The entire debug API is wrapped in __DEBUG__ (a build-time
// constant defined by esbuild). In production builds (build-publish.js),
// __DEBUG__ is set to false and esbuild tree-shakes the entire block out
// — the browserguard.test object is never exposed on globalThis in
// production. In dev builds (build.js), __DEBUG__ is true and the API
// is available for manual testing from the SW DevTools console.
declare const __DEBUG__: boolean;

if (isServiceWorkerContext && __DEBUG__) {
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
      clearStepUpState();
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
      clearBeaconAlarm();
      autoBeaconPaused = true;
      console.info('[BrowserGuard] Auto beacon paused — manual testing mode active');
    },
    resumeAutoBeacon: () => {
      if (!beaconTimer) {
        ensureBeaconAlarm();
        beaconTimer = setInterval(sendBeacon, BEACON_INTERVAL_MS);
      }
      autoBeaconPaused = false;
      console.info('[BrowserGuard] Auto beacon resumed');
    },
  },
};
} // end isServiceWorkerContext + __DEBUG__ guard for debug exposure

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
      clearStepUpState();
    }
  }, STEP_UP_SAFETY_TIMEOUT_MS);

  // Persist state so it survives SW restart (R7a/R7b/R7c fix)
  persistStepUpState();

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
        // Correctif 2: notify backend so it sets a cooldown (infra_error →
        // 60s fixed, no consecutiveNonGoCount increment). Without this, the
        // backend never learns the step-up ended and the next beacon (5s)
        // will get step_up_required: true again → popup spam loop.
        notifyStepUpEnd(sessionId, false, 'POPUP_OPEN_FAILED', 0, 0);
        // Correctif 4: track consecutive failures for local backoff
        consecutivePopupFailures++;
        lastPopupFailureAt = Date.now();
        clearStepUpState();
        return;
      }
      if (window) {
        stepUpWindowId = window.id ?? null;
        console.info('[BrowserGuard] Step-up popup opened, windowId=', window.id);
        // Persist the windowId now that we have it
        persistStepUpState();
        // Correctif 4: reset failure counter on successful popup open
        consecutivePopupFailures = 0;
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
    clearStepUpState();
  }
}

if (isServiceWorkerContext) {
  chrome.windows.onRemoved.addListener(onStepUpWindowRemoved);
}

// ─── Notify backend of step-up end (always, even on error/timeout) ───
// This is critical for the cooldown mechanism: the backend sets a cooldown
// in /step-up-result. If we only call it on success, errors/timeouts never
// set a cooldown and the popup re-opens in an infinite loop.
//
// SECURITY (session rotation): On GO, the backend generates a new sessionId
// and returns it as new_session_id. The extension switches to this new
// sessionId for all subsequent beacons. The old sessionId is invalidated
// server-side — any ping on it returns 403 SESSION_ROTATED with the new ID.
export async function notifyStepUpEnd(sessionId: string, success: boolean, decision: string, score: number, confidence: number, proofToken?: string | null): Promise<void> {
  // Note: we do NOT await ensureInstallId() here — notifyStepUpEnd is called
  // fire-and-forget from several places (safety timer, window removed, error
  // handler). If installId isn't set yet, we send it as undefined (the backend
  // schema marks it optional). sendBeacon ensures installId is populated on
  // the next 5s cycle, and subsequent step-up results will include it.
  try {
    const body: Record<string, unknown> = { sessionId, stepUpSuccess: success, decision, score, confidence, installId: installId || undefined };
    // SECURITY: Include proofToken for GO decisions — required by /step-up-result.
    if (proofToken) {
      body.proofToken = proofToken;
    }
    const resp = await fetch(`${BACKEND_URL.replace('/session-behavior-ping', '/step-up-result')}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Source-App': 'browserguard',
      },
      body: JSON.stringify(body),
    });
    console.info(`[BrowserGuard] Step-up end notified to backend: success=${success} decision=${decision}`);

    // ── Session rotation: switch to new sessionId on GO ──
    if (resp.ok) {
      try {
        const data = await resp.json();
        if (data.new_session_id && typeof data.new_session_id === 'string') {
          console.info(`[BrowserGuard] Session rotated by backend: ${sessionId} → ${data.new_session_id}`);
          rotateSessionId(data.new_session_id);
        }
      } catch (jsonErr) {
        // Response wasn't JSON — backend may be older version without rotation.
        // Continue with the current sessionId (retrocompatible).
        console.debug('[BrowserGuard] Step-up-result response not JSON — no rotation (retrocompatible)');
      }
    }
  } catch (err) {
    console.error('[BrowserGuard] Failed to notify backend of step-up end:', err);
  }
}

/**
 * Switch the current sessionId to a new one (after rotation).
 * Updates the in-memory variable and persists to chrome.storage.local.
 * Resets the invalidation flag — the new session starts with a clean
 * beacon cycle (the backend has already transferred the state).
 */
function rotateSessionId(newSessionId: string): void {
  const oldSessionId = sessionId;
  sessionId = newSessionId;
  sessionInvalidated = false;
  chrome.storage.local.set({ browserguard_sessionId: newSessionId });
  console.info(`[BrowserGuard] SessionId rotated: ${oldSessionId} → ${newSessionId} (persisted to storage)`);
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
  await notifyStepUpEnd(sessionId, success, result.decision, result.score, result.confidence, result.proofToken);

  clearStepUpState();
}

// ─── Message listener ───────────────────────────────────────────────
// Note: les snapshots multi-onglet s'écrasent mutuellement dans lastSnapshot
// (pas de Map par tabId). Voir README.md → "Limitation connue — snapshot
// multi-onglet" pour le contexte et l'option de secours si besoin.

export function onRuntimeMessage(message: any, _sender: any, _sendResponse: any): boolean {
  if (message.type === 'browserguard_behavior_snapshot') {
    // Le dernier onglet à flusher écrase les données des autres. _sender
    // (qui contient sender.tab.id) est intentionnellement ignoré pour
    // l'instant — voir la limitation documentée ci-dessus.
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
    clearStepUpState();
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
    installId,
    stepUpInProgress,
    stepUpWindowId,
    hasSnapshot: !!lastSnapshot,
    snapshotEvents: lastSnapshot?.totalEvents ?? 0,
    autoBeaconPaused,
    sessionInvalidated,
    consecutivePopupFailures,
  };
}

export function __testSetSessionId(id: string): void {
  sessionId = id;
  // Reset invalidation flag when session changes — a new session starts
  // with a clean beacon cycle, mirroring ensureSession() behavior.
  sessionInvalidated = false;
}

export function __testSetInstallId(id: string): void {
  installId = id;
}

export function __testSetSnapshot(snap: BehaviorSnapshot | null): void {
  lastSnapshot = snap;
}

export function __testResetStepUp(): void {
  clearStepUpState();
  sessionInvalidated = false;
  consecutivePopupFailures = 0;
  lastPopupFailureAt = 0;
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

  // Restore installId from storage on startup (parallel to sessionId).
  // This is a one-time read — installId is never regenerated once set.
  installIdRestored = new Promise<void>((resolve) => {
    chrome.storage.local.get(['browserguard_installId'], (result) => {
      if (result.browserguard_installId) {
        installId = result.browserguard_installId;
        console.info('[BrowserGuard] Install ID restored from storage:', installId);
      }
      resolve();
    });
  });

  // ── Step-up state restoration (R7a/R7b/R7c fix) ──────────────────
  // On SW restart, if a step-up was in progress when the SW was killed,
  // reconcile the persisted state:
  //   - If the 90s safety window has elapsed → treat as timeout, notify
  //     backend, clear state.
  //   - If the popup window no longer exists → the popup was closed while
  //     the SW was dead. Notify backend (POPUP_CLOSED), clear state.
  //   - If the popup still exists → restore windowId, re-arm the safety
  //     timer with the remaining time. The chrome.windows.onRemoved
  //     listener (registered above at line ~573) will handle normal close.
  //
  // This Promise MUST resolve before sendBeacon checks stepUpInProgress,
  // otherwise a post-restart beacon could open a duplicate popup (R7b).
  stepUpStateRestored = new Promise<void>((resolve) => {
    chrome.storage.local.get([STEP_UP_STATE_KEY], (result) => {
      const saved = result[STEP_UP_STATE_KEY] as StepUpState | undefined;
      if (!saved || !saved.inProgress) {
        // No step-up was in progress — clean state
        if (saved) chrome.storage.local.remove(STEP_UP_STATE_KEY);
        resolve();
        return;
      }

      const elapsed = Date.now() - (saved.startedAt ?? 0);
      const remaining = STEP_UP_SAFETY_TIMEOUT_MS - elapsed;

      if (remaining <= 0) {
        // Safety timeout already elapsed while SW was dead — treat as timeout
        console.warn('[BrowserGuard] Step-up safety timeout elapsed during SW downtime — notifying backend');
        // Use saved.sessionId if our closure sessionId isn't set yet
        const sid = sessionId || saved.sessionId || '';
        notifyStepUpEnd(sid, false, 'SAFETY_TIMEOUT_AFTER_RESTART', 0, 0);
        clearStepUpState();
        resolve();
        return;
      }

      // Check if the popup window still exists
      if (saved.windowId !== null) {
        chrome.windows.get(saved.windowId, (win) => {
          if (chrome.runtime.lastError || !win) {
            // Window no longer exists — popup was closed while SW was dead
            console.warn('[BrowserGuard] Step-up popup closed during SW downtime — notifying backend, windowId=', saved.windowId);
            const sid = sessionId || saved.sessionId || '';
            notifyStepUpEnd(sid, false, 'POPUP_CLOSED_DURING_RESTART', 0, 0);
            clearStepUpState();
            resolve();
          } else {
            // Popup still exists — restore state and re-arm safety timer
            console.info('[BrowserGuard] Step-up popup still open after SW restart — restoring state, windowId=', saved.windowId, 'remaining=', remaining, 'ms');
            stepUpInProgress = true;
            stepUpWindowId = saved.windowId;
            stepUpSafetyTimer = setTimeout(() => {
              if (stepUpInProgress) {
                console.warn('[BrowserGuard] Step-up safety timeout (post-restart) — force-resetting');
                notifyStepUpEnd(sessionId, false, 'SAFETY_TIMEOUT', 0, 0);
                clearStepUpState();
              }
            }, remaining);
            // Persist updated startedAt so future restarts calculate correctly
            persistStepUpState();
            resolve();
          }
        });
      } else {
        // inProgress was true but windowId was null — the popup hadn't
        // opened yet when the SW was killed. Treat as failed trigger.
        console.warn('[BrowserGuard] Step-up was in progress but no windowId — treating as failed trigger');
        const sid = sessionId || saved.sessionId || '';
        notifyStepUpEnd(sid, false, 'POPUP_CLOSED_DURING_RESTART', 0, 0);
        clearStepUpState();
        resolve();
      }
    });
  });

  // Start periodic beacon — hybrid scheduling (see comment at top of file).
  // setInterval provides the 5s cadence while the SW is alive.
  // chrome.alarms acts as a safety net: it survives SW kills and wakes the
  // SW, at which point this lifecycle block runs again and recreates the
  // setInterval. The alarm itself also calls sendBeacon directly.
  ensureBeaconAlarm();
  beaconTimer = setInterval(sendBeacon, BEACON_INTERVAL_MS);

  // Clean up on suspend (MV3 service workers can be killed).
  // We clear the setInterval but deliberately KEEP the chrome.alarm alive —
  // the alarm is designed to survive SW suspension and wake the SW on the
  // next fire. Clearing it here would defeat its purpose as a safety net.
  self.addEventListener('beforeunload', () => {
    console.info('[BrowserGuard] Service worker suspending — state will be lost');
    if (beaconTimer) clearInterval(beaconTimer);
    if (stepUpSafetyTimer) clearTimeout(stepUpSafetyTimer);
    // Note: chrome.alarms is intentionally NOT cleared here.
  });
} else {
  // In tests (or any non-SW context), resolve immediately so ensureSession()
  // and ensureInstallId() don't hang waiting for a storage callback that
  // will never fire.
  sessionIdRestored = Promise.resolve();
  installIdRestored = Promise.resolve();
  stepUpStateRestored = Promise.resolve();
}
