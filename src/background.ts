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

import { STEP_UP_PAGE_PATH, POPUP_PAGE_PATH } from './page-paths.js';
import { computeStatus, buildStatusResponse, type LastStepUpResult } from './status';
import { tUi } from './i18n-ui';

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

// ─── Build-time configuration (Phase 6) ─────────────────────────────
// esbuild `define` injects these per build flavor. All three builds
// define them — production builds use the production literals, so the
// emitted bundle folds to exactly the previous hardcoded values.
// typeof-guards keep the module importable under vitest (no define).
declare const __BG_API_BASE__: string;
declare const __BG_STEPUP_BASE__: string;
declare const __BG_DEV__: boolean;

const API_BASE = typeof __BG_API_BASE__ === 'string' ? __BG_API_BASE__ : 'https://api.hcs-u7.org/hv';
const STEP_UP_BASE = typeof __BG_STEPUP_BASE__ === 'string' ? __BG_STEPUP_BASE__ : 'https://challenge.hcs-u7.org';
// Dev flag is mutable via __testSetDevBuild so tests can exercise both
// the production path (no local fallback) and the dev fallback. Code that
// must be TREE-SHAKEN out of production bundles (the storage.local key
// fallback) is additionally gated on the `__BG_DEV__` literal INLINE in
// the condition — esbuild folds `false && …` in prod and drops the
// branch + its strings. (Do NOT extract the literal into a const —
// esbuild does not propagate it far enough to kill the branch.)
let IS_DEV_BUILD = typeof __BG_DEV__ !== 'undefined' && __BG_DEV__ === true;

const BACKEND_URL = `${API_BASE}/api/browserguard/session-behavior-ping`;
const STEP_UP_URL_BASE = `${STEP_UP_BASE}/embed/`;

// ─── Tenant ingest key (Phase 6 — X-BrowserGuard-Key) ───────────────
// The key is provisioned by the enterprise admin via Chrome policy
// (chrome.storage.managed, schema declared in managed_schema.json).
// It is NEVER bundled — a secret shipped in the package is public.
// Dev builds only (IS_DEV_BUILD): fallback to chrome.storage.local
// for manual testing without a policy install — tree-shaken in prod.
//
// SANS CLE = RIEN: when refreshIngestKey() returns null, sendBeacon()
// and notifyStepUpEnd() return before any network call, and content
// scripts are told (via broadcastCollectionState) not to capture.
let ingestKey: string | null = null;
let ingestKeyFetchedAt = 0;
const INGEST_KEY_CACHE_MS = 60_000;
const MANAGED_KEY_FIELD = 'ingestKey';
const DEV_LOCAL_KEY_FIELD = 'browserguard_ingestKey';
const MIN_INGEST_KEY_LENGTH = 32;

function storageAreaGet(area: chrome.storage.StorageArea, key: string): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    try {
      area.get(key, (result: Record<string, unknown>) => resolve(result ?? {}));
    } catch {
      resolve({});
    }
  });
}

function isValidIngestKey(v: unknown): v is string {
  return typeof v === 'string' && v.length >= MIN_INGEST_KEY_LENGTH;
}

export async function refreshIngestKey(force = false): Promise<string | null> {
  if (!force && ingestKey && Date.now() - ingestKeyFetchedAt < INGEST_KEY_CACHE_MS) {
    return ingestKey;
  }
  let key: string | null = null;
  // chrome.storage.managed only exists when the manifest declares
  // storage.managed_schema — absent in production builds for now.
  if (chrome.storage?.managed) {
    const m = await storageAreaGet(chrome.storage.managed, MANAGED_KEY_FIELD);
    if (isValidIngestKey(m[MANAGED_KEY_FIELD])) key = m[MANAGED_KEY_FIELD];
  }
  // Dev-only fallback — the __BG_DEV__ literal must stay INLINE in the
  // condition so esbuild removes this whole branch (and the
  // 'browserguard_ingestKey' string) from prod bundles.
  if (!key && typeof __BG_DEV__ !== 'undefined' && __BG_DEV__ === true && IS_DEV_BUILD) {
    const l = await storageAreaGet(chrome.storage.local, DEV_LOCAL_KEY_FIELD);
    if (isValidIngestKey(l[DEV_LOCAL_KEY_FIELD])) key = l[DEV_LOCAL_KEY_FIELD];
  }
  ingestKey = key;
  ingestKeyFetchedAt = Date.now();
  return key;
}

// ─── Collection gating broadcast (Phase 6) ──────────────────────────
// Content scripts never read the key. On load they ask the SW whether
// collection is allowed (browserguard_collection_query); the SW then
// broadcasts browserguard_collection_state to all tabs whenever the
// key appears or disappears. tabs.query/tabs.sendMessage do NOT require
// the "tabs" permission (only tab.id is used — a non-sensitive field).
export async function broadcastCollectionState(): Promise<void> {
  const key = await refreshIngestKey(true); // force re-read — policy just changed
  updateActionBadge();
  const msg = { type: 'browserguard_collection_state', enabled: !!key };
  chrome.tabs.query({}, (tabs) => {
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      chrome.tabs.sendMessage(tab.id, msg, () => {
        // Tab without a content script (chrome://, new tab page) — expected.
        void chrome.runtime.lastError;
      });
    }
  });
}

// ─── Server-error backoff + step-up reject cooldown (Phase 6) ───────
// 403 AUTH_FAILED / 500 TENANT_NOT_RESOLVED / 503 CHECK_UNAVAILABLE are
// server-side rejects — retrying faster cannot help, and each retried
// ping burns the server-side step-up offer budget (3/session). Exponential
// backoff capped at 5 min; one warn per rejection, silent skips after.
// After ANY rejected /step-up-result: ≥60s before another popup.
let serverBackoffUntil = 0;
let serverBackoffStep = 0;
const SERVER_BACKOFF_BASE_MS = 5_000;
const SERVER_BACKOFF_MAX_MS = 300_000;
let tenantMismatchRotated = false;
const STEP_UP_REJECT_COOLDOWN_MS = 60_000;
let stepUpRejectedUntil = 0;

function recordServerBackoff(reason: string): void {
  const delay = Math.min(SERVER_BACKOFF_BASE_MS * 2 ** serverBackoffStep, SERVER_BACKOFF_MAX_MS);
  serverBackoffStep = Math.min(serverBackoffStep + 1, 8);
  serverBackoffUntil = Date.now() + delay;
  console.warn(`[BrowserGuard] Server backoff ${Math.round(delay / 1000)}s — ${reason}`);
}

// ─── Beacon in-flight tracking + fetch timeout (audit v0.2.1) ───────
// WITHOUT this guard, multiple sendBeacon() calls can overlap (setInterval
// + chrome.alarms + manual triggerBeacon), sending concurrent fetches on
// the same session. The backend's Redis lock serializes the read-modify-
// write, but concurrent beacons inflate recentPingCount (mass-attempt
// counter) — a triple overlap (36/min) can cross MASS_ATTEMPT_THRESHOLD=30
// and cause unjustified invalidation.
//
// The AbortController timeout (10s) prevents resource exhaustion when the
// backend hangs (accepts the TCP connection but never responds). Without
// it, the 5s setInterval accumulates hanging fetches indefinitely, each
// holding a connection.
const BEACON_FETCH_TIMEOUT_MS = 10_000;
let beaconInFlight: boolean = false;
let beaconAbortController: AbortController | null = null;

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

// ── Status model (Phase 6b) ─────────────────────────────────────────
// These feed computeStatus() (badge) and the sanitized status response
// sent to the dev popup. consecutiveBeaconFailures counts ONLY fetches
// that actually left the browser and failed — skipped sends (no key,
// backoff, no snapshot, step-up in progress, invalidated) never count.
let lastBeaconOkAt = 0;               // 0 = no beacon accepted yet
let consecutiveBeaconFailures = 0;
let stepUpRequiredPending = false;    // server required a step-up (see resets)
let lastStepUpResult: LastStepUpResult | null = null;
const LAST_STEPUP_RESULT_KEY = 'browserguard_lastStepUpResult';
const LAST_BEACON_OK_KEY = 'browserguard_lastBeaconOkAt';

interface StatusSnapshot {
  hasKey: boolean;
  lastBeaconOkAt: number;
  consecutiveBeaconFailures: number;
  stepUpRequiredPending: boolean;
  stepUpInProgress: boolean;
  serverBackoffUntil: number;
  sessionInvalidated: boolean;
  now: number;
}

export function statusSnapshot(): StatusSnapshot {
  return {
    hasKey: !!ingestKey,
    lastBeaconOkAt,
    consecutiveBeaconFailures,
    stepUpRequiredPending,
    stepUpInProgress,
    serverBackoffUntil,
    sessionInvalidated,
    now: Date.now(),
  };
}

// Dev-only badge update — the __BG_DEV__ literal stays INLINE and the
// dev condition wraps the whole body in an if-STATEMENT (not an early
// return). An `if (false) {…}` is eliminated during parsing so esbuild
// never even marks computeStatus/tUi as used: both are tree-shaken out
// of production bundles. An early-return guard folds to `if(true)return`
// and leaves the body in the AST — which is what leaked dev strings
// into dist-publish before.
export function updateActionBadge(): void {
  if (typeof __BG_DEV__ !== 'undefined' && __BG_DEV__ === true && IS_DEV_BUILD && isServiceWorkerContext) {
    try {
      const v = computeStatus(statusSnapshot());
      void chrome.action.setBadgeText({ text: v.badgeText });
      void chrome.action.setBadgeBackgroundColor({ color: v.badgeColor });
      void chrome.action.setTitle({ title: `BrowserGuard — ${tUi(v.titleKey)}` });
    } catch { /* chrome.action unavailable */ }
  }
}

function persistSessionStatus(): void {
  try { chrome.storage?.session?.set({ [LAST_BEACON_OK_KEY]: lastBeaconOkAt }); } catch { /* ignore */ }
}

function persistLastStepUpResult(): void {
  try { chrome.storage?.session?.set({ [LAST_STEPUP_RESULT_KEY]: lastStepUpResult }); } catch { /* ignore */ }
}

// Restore status fields from chrome.storage.session on SW startup —
// survives SW sleep (memory only, never persisted to disk). Without it
// a woken SW would show "connecting" to a user who is simply idle.
export function restoreSessionStatus(): Promise<void> {
  return new Promise<void>((resolve) => {
    try {
      const area = chrome.storage?.session;
      if (!area?.get) { resolve(); return; }
      area.get([LAST_STEPUP_RESULT_KEY, LAST_BEACON_OK_KEY], (r: Record<string, unknown>) => {
        const ls = r?.[LAST_STEPUP_RESULT_KEY] as LastStepUpResult | undefined;
        if (ls && typeof ls.at === 'number') lastStepUpResult = ls;
        const lb = r?.[LAST_BEACON_OK_KEY];
        if (typeof lb === 'number') lastBeaconOkAt = lb;
        updateActionBadge();
        resolve();
      });
    } catch { resolve(); }
  });
}

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
  stepUpRequiredPending = false; // no pending step-up survives this reset
  if (stepUpSafetyTimer) {
    clearTimeout(stepUpSafetyTimer);
    stepUpSafetyTimer = null;
  }
  if (isServiceWorkerContext) {
    chrome.storage.local.remove(STEP_UP_STATE_KEY);
  }
  updateActionBadge();
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
//
// Platform detection (audit v0.2.1 — P3 fix):
//   Primary: navigator.userAgent (available in MV3 service workers).
//            Detects Mobile/Tablet via UA string hints (Android, iPhone,
//            iPad, Mobile token).
//   Fallback: viewport ratio — if the content script reports a narrow
//             viewport (<768px) with a high pixel ratio (≥2), infer
//             mobile. This catches cases where the UA is ambiguous
//             (e.g. Chrome on desktop with mobile emulation, or a
//             future UA-string reduction that drops platform hints).
//
// The previous implementation hardcoded platform: 'desktop', causing
// mobile users to be misclassified. The backend's normalizeByDevice
// uses viewportWidth for speed normalization (correct regardless of
// platform), but platform may be used for scoring calibration — a
// mobile user classified as 'desktop' could get miscalibrated thresholds.

/**
 * Detect platform from navigator.userAgent. Exported for testing.
 *
 * Detection logic (order matters — iPadOS 13+ reports as Macintosh):
 *   1. iPad (iPadOS 13+): UA contains "Macintosh" + "Safari" but NOT
 *      "Chrome" → check navigator.maxTouchPoints > 0 at call site.
 *      In the SW context, we use the viewport+pixelRatio fallback for
 *      this edge case (iPad reports a desktop-like UA but has a small
 *      viewport and high pixelRatio).
 *   2. Mobile: UA contains "Mobi" (covers "Mobile", "Mobile Safari"),
 *      "Android", "iPhone", or "iPod".
 *   3. Tablet: UA contains "iPad" or "Tablet" (some Android tablets).
 *   4. Desktop: everything else.
 */
export function detectPlatformFromUA(ua: string | undefined): 'desktop' | 'mobile' | 'tablet' {
  if (!ua) return 'desktop';
  // iPadOS 13+ reports "Macintosh" in UA but is a tablet. The standard
  // detection (Mozilla's recommendation) checks maxTouchPoints, but the
  // SW doesn't have a reliable maxTouchPoints. We detect iPad explicitly
  // via the "iPad" token (present in some iPadOS versions) and fall back
  // to viewport-based detection in getDeviceContext for the Macintosh case.
  if (/iPad|Tablet/i.test(ua)) return 'tablet';
  // Mobile tokens — "Mobi" covers "Mobile" and "Mobile Safari".
  // "Android" without "Tablet" → mobile (phones). "iPhone"/"iPod" → mobile.
  if (/Mobi|Android|iPhone|iPod/i.test(ua)) return 'mobile';
  return 'desktop';
}

/**
 * Infer platform from viewport dimensions and pixel ratio (fallback when
 * UA detection is ambiguous, e.g. iPadOS 13+ reporting as Macintosh).
 *
 * Heuristic: a narrow viewport (<768px CSS width) with high pixel ratio
 * (≥2) is almost certainly a phone. A medium viewport (768-1024px) with
 * high pixel ratio is likely a tablet. Everything else → desktop.
 */
export function inferPlatformFromViewport(
  viewportWidth: number,
  pixelRatio: number,
): 'desktop' | 'mobile' | 'tablet' {
  if (viewportWidth < 768 && pixelRatio >= 1.5) return 'mobile';
  if (viewportWidth >= 768 && viewportWidth < 1024 && pixelRatio >= 1.5) return 'tablet';
  return 'desktop';
}

function getDeviceContext(snap?: BehaviorSnapshot): {
  viewportWidth: number;
  viewportHeight: number;
  pixelRatio: number;
  platform: 'desktop' | 'mobile' | 'tablet';
} {
  const viewportWidth = snap?.viewportWidth ?? 1920;
  const viewportHeight = snap?.viewportHeight ?? 1080;
  const pixelRatio = snap?.pixelRatio ?? 1;

  // Primary: navigator.userAgent (available in MV3 service workers)
  let platform = detectPlatformFromUA(
    typeof navigator !== 'undefined' ? navigator.userAgent : undefined
  );

  // Fallback: if UA says desktop but the viewport looks mobile/tablet,
  // trust the viewport. This catches iPadOS 13+ (reports as Macintosh)
  // and desktop browsers with mobile emulation enabled.
  if (platform === 'desktop') {
    const viewportPlatform = inferPlatformFromViewport(viewportWidth, pixelRatio);
    if (viewportPlatform !== 'desktop') {
      platform = viewportPlatform;
    }
  }

  return { viewportWidth, viewportHeight, pixelRatio, platform };
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
  // ── In-flight guard (audit v0.2.1) ──
  // Prevents concurrent sendBeacon() calls from overlapping. Without this,
  // a slow fetch (>5s) causes the next setInterval tick to launch a second
  // fetch on the same session, inflating the backend's recentPingCount
  // (mass-attempt counter) and potentially crossing the 30/60s threshold.
  // Also prevents accumulation of hanging fetches when the backend is slow
  // or unresponsive (combined with the AbortController timeout below).
  //
  // CRITICAL: beaconInFlight is set BEFORE any await. If it were set after
  // the awaits (ensureSession, stepUpStateRestored, etc.), multiple
  // concurrent calls could all pass the guard before any of them sets the
  // flag — defeating the purpose. The outer try/finally ensures the flag
  // is always reset, even on early returns or exceptions.
  if (beaconInFlight) {
    console.debug('[BrowserGuard] Beacon skipped: previous beacon still in flight');
    return;
  }
  if (!lastSnapshot || lastSnapshot.totalEvents === 0) {
    console.debug('[BrowserGuard] Beacon skipped: no snapshot or zero events');
    return;
  }

  beaconInFlight = true;
  try {
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
    if (Date.now() < serverBackoffUntil) {
      // A previous beacon/step-up-result was rejected server-side
      // (AUTH_FAILED, TENANT_NOT_RESOLVED, …). Retrying now would only burn
      // the step-up offer budget — skip silently until the backoff expires.
      console.debug('[BrowserGuard] Beacon skipped: server backoff active');
      return;
    }

    await ensureSession();
    await ensureInstallId();
    await computeBundleHash();

    // SANS CLE = RIEN (Phase 6): without a provisioned tenant ingest key,
    // no beacon is sent at all — the server would 403 AUTH_FAILED anyway.
    const tenantKey = await refreshIngestKey();
    if (!tenantKey) {
      console.debug('[BrowserGuard] Beacon skipped: no ingest key provisioned (chrome.storage.managed)');
      return;
    }

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

    // ── Fetch timeout (audit v0.2.1) ──
    // AbortController + setTimeout enforces a 10s timeout — without it, a
    // hanging backend (TCP accepted, no response) causes the fetch to hang
    // indefinitely. Combined with beaconInFlight (which prevents new fetches
    // while one is in flight), this ensures at most 1 hanging fetch at any
    // time, auto-aborted after 10s.
    beaconAbortController = new AbortController();
    const timeoutId = setTimeout(() => {
      beaconAbortController?.abort();
    }, BEACON_FETCH_TIMEOUT_MS);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Source-App': 'browserguard',
      'X-BrowserGuard-Key': tenantKey,
    };

    try {
      const doPing = (payload: typeof body) => fetch(BACKEND_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
        signal: beaconAbortController!.signal,
      });

      let resp = await doPing(body);
      let errData: { error?: string; new_session_id?: string } | null = null;

      if (!resp.ok) {
        errData = await resp.json().catch(() => null);
        // ── Session rotation recovery (fallback) ──
        // 403 SESSION_ROTATED means the current sessionId was rotated
        // (step-up GO) but we missed the new_session_id. The backend
        // includes it in the error — switch and retry the beacon ONCE.
        // A retry that also fails goes through normal error classification
        // below — there is never a second retry, never a loop.
        if (resp.status === 403 && errData?.error === 'SESSION_ROTATED' && errData.new_session_id) {
          console.info(`[BrowserGuard] Beacon rejected (SESSION_ROTATED) — switching to new sessionId: ${errData.new_session_id}`);
          rotateSessionId(errData.new_session_id);
          // Reuse the same AbortController signal — the 10s timeout
          // covers the total time including this single retry.
          resp = await doPing({ ...body, sessionId });
          errData = resp.ok ? null : await resp.json().catch(() => null);
          if (resp.ok) {
            console.info('[BrowserGuard] Beacon retry with rotated sessionId succeeded');
          }
        }
      }

      if (!resp.ok) {
        // A fetch actually left the browser and was rejected — count it
        // (skipped sends never reach here). ≥3 → error badge.
        consecutiveBeaconFailures++;
        const code = errData?.error;
        if (resp.status === 403 && code === 'BROWSERGUARD_AUTH_FAILED') {
          // Key rejected (revoked/unknown/tenant inactive). Drop the cache
          // so the next attempt re-reads the policy, then back off — a
          // wrong key never becomes right by retrying.
          ingestKey = null;
          recordServerBackoff('BROWSERGUARD_AUTH_FAILED');
          return;
        }
        if (resp.status === 403 && code === 'BROWSERGUARD_TENANT_MISMATCH') {
          // The session is bound to a different tenant. Regenerate the
          // sessionId ONCE so the next cycle binds to this key's tenant —
          // never more than once per error streak.
          if (!tenantMismatchRotated) {
            tenantMismatchRotated = true;
            console.warn('[BrowserGuard] Session bound to another tenant — regenerating sessionId once');
            rotateSessionId(generateSessionId());
          }
          recordServerBackoff('BROWSERGUARD_TENANT_MISMATCH');
          return;
        }
        if (code === 'BROWSERGUARD_TENANT_NOT_RESOLVED' || code === 'BROWSERGUARD_TENANT_CHECK_UNAVAILABLE') {
          // 500/503 — server couldn't resolve the tenant. Transient or
          // misconfiguration; back off, no popup, no state changes.
          recordServerBackoff(code!);
          return;
        }
        console.error('[BrowserGuard] Beacon failed:', resp.status);
        return;
      }

      // A successful response clears the backoff, the failure counter
      // and the one-shot tenant-mismatch rotation flag. It also marks
      // "server reachable" for the status badge (persisted to
      // storage.session so a SW restart doesn't regress to connecting).
      serverBackoffUntil = 0;
      serverBackoffStep = 0;
      tenantMismatchRotated = false;
      consecutiveBeaconFailures = 0;
      lastBeaconOkAt = Date.now();
      persistSessionStatus();

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
        stepUpRequiredPending = false; // no step-up on a dead session
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

      // Check for step-up requirement. stepUpRequiredPending drives the
      // orange badge — every path that does NOT open a popup resets it
      // so the badge never stays orange without a real pending step-up.
      if (data.step_up_required === true) stepUpRequiredPending = true;
      if (data.step_up_required === true && data.step_up_url && !stepUpInProgress) {
        if (Date.now() < stepUpRejectedUntil) {
          stepUpRequiredPending = false;
          // Phase 6: a step-up-result was rejected <60s ago. The server
          // cooldown is only set on ACCEPTED results — without this guard
          // every 5s beacon would re-open the popup in a loop. (Limitation:
          // each suppressed offer still decrements the server-side step-up
          // budget — see README "Limites connues".)
          console.debug('[BrowserGuard] Step-up required but a recent step-up-result was rejected — popup suppressed (60s guard)');
        } else if (
          // Correctif 4: local backoff after consecutive popup open failures.
          // If chrome.windows.create has failed 3+ times in the last 120s,
          // skip the trigger to avoid spamming failed popup attempts. The
          // backend cooldown (Correctif 1+2) is the primary protection; this
          // is a defensive local net for when the backend doesn't cooperate.
          consecutivePopupFailures >= POPUP_FAILURE_THRESHOLD &&
          (Date.now() - lastPopupFailureAt) < POPUP_FAILURE_BACKOFF_MS
        ) {
          stepUpRequiredPending = false;
          const remaining = Math.ceil((POPUP_FAILURE_BACKOFF_MS - (Date.now() - lastPopupFailureAt)) / 1000);
          console.warn(`[BrowserGuard] Step-up required but skipping popup — ${consecutivePopupFailures} consecutive open failures, local backoff ${remaining}s remaining`);
        } else {
          console.info('[BrowserGuard] Step-up required, triggering popup');
          triggerStepUp(data.step_up_url);
        }
      } else if (data.step_up_required === true && !data.step_up_url) {
        stepUpRequiredPending = false;
        console.warn('[BrowserGuard] Step-up required but no step_up_url in response');
      } else if (data.step_up_required === true && stepUpInProgress) {
        console.debug('[BrowserGuard] Step-up required but already in progress, skipping');
      }
    } catch (err) {
      // The fetch left the browser (or tried to) and threw — count it.
      consecutiveBeaconFailures++;
      // AbortError is expected when the 10s timeout fires — log at debug
      // level to avoid spamming the console during a backend outage.
      if (err instanceof DOMException && err.name === 'AbortError') {
        console.debug('[BrowserGuard] Beacon timed out after', BEACON_FETCH_TIMEOUT_MS, 'ms — backend unresponsive');
      } else {
        console.error('[BrowserGuard] Beacon error:', err);
      }
    } finally {
      clearTimeout(timeoutId);
      beaconAbortController = null;
    }
  } finally {
    beaconInFlight = false;
    updateActionBadge(); // recompute after every beacon attempt (dev only)
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

  // Build the step-up.html URL with query params — the path comes from
  // the shared constant also used by the sender guard and build-dev.js.
  const extensionUrl = chrome.runtime.getURL(STEP_UP_PAGE_PATH);
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
export interface StepUpNotifyResult {
  sent: boolean;      // a request actually left the browser
  accepted: boolean;  // the server answered 2xx
  status?: number;
  code?: string;      // server error code or 'NO_KEY' / 'NETWORK'
}

export async function notifyStepUpEnd(sessionId: string, success: boolean, decision: string, score: number, confidence: number, proofToken?: string | null): Promise<StepUpNotifyResult> {
  // Note: we do NOT await ensureInstallId() here — notifyStepUpEnd is called
  // fire-and-forget from several places (safety timer, window removed, error
  // handler). If installId isn't set yet, we send it as undefined (the backend
  // schema marks it optional). sendBeacon ensures installId is populated on
  // the next 5s cycle, and subsequent step-up results will include it.
  try {
    // SANS CLE = RIEN (Phase 6): no provisioned key → no request at all.
    // The server would reject with AUTH_FAILED anyway.
    const tenantKey = await refreshIngestKey();
    if (!tenantKey) {
      console.debug('[BrowserGuard] step-up-result not sent: no ingest key provisioned');
      return { sent: false, accepted: false, code: 'NO_KEY' };
    }
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
        'X-BrowserGuard-Key': tenantKey,
      },
      body: JSON.stringify(body),
    });
    console.info(`[BrowserGuard] Step-up end notified to backend: success=${success} decision=${decision}`);

    if (!resp.ok) {
      // A rejected step-up-result sets NO server-side cooldown — without
      // this guard the next beacon gets step_up_required again and the
      // popup re-opens in a loop. Minimum 60s between popups after ANY
      // rejection.
      stepUpRejectedUntil = Date.now() + STEP_UP_REJECT_COOLDOWN_MS;
      const errData = await resp.json().catch(() => null) as { error?: string } | null;
      const code = errData?.error;
      if (code === 'BROWSERGUARD_SESSION_UNKNOWN') {
        // Session dead server-side — the popup is already closed; start a
        // fresh session bound to this key's tenant. The 60s guard above
        // prevents any immediate popup re-trigger on the new session.
        console.warn('[BrowserGuard] step-up-result rejected: session unknown — regenerating sessionId');
        rotateSessionId(generateSessionId());
      } else if (
        code === 'BROWSERGUARD_AUTH_FAILED' || code === 'BROWSERGUARD_TENANT_MISMATCH' ||
        code === 'BROWSERGUARD_TENANT_NOT_RESOLVED' || code === 'BROWSERGUARD_TENANT_CHECK_UNAVAILABLE'
      ) {
        // Same classification as the beacon path — drop the cached key so
        // the policy is re-read, and back the BEACONS off so no further
        // step-up offer budget is burned.
        ingestKey = null;
        recordServerBackoff(`step-up-result:${code}`);
      }
      console.warn(`[BrowserGuard] step-up-result rejected (${resp.status}${code ? ` ${code}` : ''}) — popup paused 60s`);
      return { sent: true, accepted: false, status: resp.status, code };
    }

    // ── Session rotation: switch to new sessionId on GO ──
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
    return { sent: true, accepted: true, status: resp.status };
  } catch (err) {
    console.error('[BrowserGuard] Failed to notify backend of step-up end:', err);
    return { sent: false, accepted: false, code: 'NETWORK' };
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
  stepUpRequiredPending = false; // a rotated session carries no pending offer
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

export interface StepUpVerdict {
  // success = iframe decision was GO-like AND the server ACCEPTED the
  // step-up-result (2xx). A server-rejected GO is NEVER "passed".
  success: boolean;
  code?: string; // rejection code (internal use only — never displayed raw)
}

export async function handleStepUpResult(result: StepUpResultMessage): Promise<StepUpVerdict> {
  console.info('[BrowserGuard] Step-up result received:', result.decision, 'score=', result.score);
  const decisionOk = isStepUpSuccess(result);
  // NOT result.sessionId. The popup relays currentSession.sessionId from the
  // GateGuard embed iframe (embed.js:351), which is the GateGuard-internal
  // session ID returned by /session/start — a different identifier than the
  // BrowserGuard behavioral session ID used for Redis keys, beacons, and
  // cooldown. Using result.sessionId here would write the cooldown and the
  // emaDivergence reset under an orphan Redis key (browserguard:behavior:session:<gg_...>)
  // that the beacons never read, making the cooldown and the state repair
  // completely inoperative (re-trigger loop on every ping, even after a GO).
  const notify = await notifyStepUpEnd(sessionId, decisionOk, result.decision, result.score, result.confidence, result.proofToken);

  // Verdict shown to the user = iframe decision AND server acceptance.
  const success = decisionOk && notify.accepted;
  lastStepUpResult = { at: Date.now(), success, decision: result.decision };
  persistLastStepUpResult(); // storage.session — survives SW sleep

  clearStepUpState();
  updateActionBadge();
  return { success, code: notify.accepted ? undefined : (notify.code ?? 'NOT_ACCEPTED') };
}

// ─── Message listener ───────────────────────────────────────────────
// Note: les snapshots multi-onglet s'écrasent mutuellement dans lastSnapshot
// (pas de Map par tabId). Voir README.md → "Limitation connue — snapshot
// multi-onglet" pour le contexte et l'option de secours si besoin.

// ─── Sender guard ───────────────────────────────────────────────────
// runtime.onMessage fires for content scripts of THIS extension and for
// our own extension pages. A content script runs on EVERY web page —
// so browserguard_stepup_result (a trusted attestation channel) must
// only be accepted from the step-up page itself, and queries/results
// are restricted to the context that legitimately emits them.
// sender.url always carries our query params — compare the PARSED
// origin + pathname, never strict string equality.
function senderExtensionPathname(sender: chrome.runtime.MessageSender | undefined): string | null {
  try {
    const u = new URL(sender?.url ?? '');
    // Compare protocol+host+pathname — NOT u.origin: non-special schemes
    // return 'null' for origin per the WHATWG URL spec (and would break
    // under Node-based tests). host holds the extension id either way.
    const isExt = u.protocol === 'chrome-extension:' && u.host === chrome.runtime.id;
    return isExt ? u.pathname : null;
  } catch {
    return null;
  }
}

export function onRuntimeMessage(message: any, sender: any, sendResponse: any): boolean {
  const fromExtension = sender?.id === chrome.runtime.id;
  const extPath = senderExtensionPathname(sender);
  const fromStepUpPage = fromExtension && extPath === `/${STEP_UP_PAGE_PATH}`;
  // A content script runs inside a web page: sender.tab.id is defined
  // AND sender.url is NOT our extension origin.
  const fromContentScript = fromExtension && sender?.tab?.id !== undefined && extPath === null;

  const reject = (what: string): boolean => {
    console.warn(`[BrowserGuard] Message ${what} rejected: unauthorized sender`);
    return false;
  };

  if (message.type === 'browserguard_collection_query') {
    if (!fromContentScript) return reject(message.type);
    // Content script asks whether behavioral collection is allowed.
    // The key is checked SW-side only — content scripts never read it.
    // Async sendResponse: return true keeps the message channel open.
    void refreshIngestKey().then((k) => sendResponse({ collectionEnabled: !!k }));
    return true;
  }

  // Dev-only status channel (popup exists only in dist-dev). The
  // __BG_DEV__ literal stays INLINE so the handler, the sender check and
  // the 'popup.html' string are all tree-shaken out of prod bundles.
  if (typeof __BG_DEV__ !== 'undefined' && __BG_DEV__ === true && IS_DEV_BUILD &&
      message.type === 'browserguard_status_query') {
    const fromPopup = fromExtension && extPath === `/${POPUP_PAGE_PATH}`;
    if (!fromPopup) return reject(message.type);
    // Dev popup asks for the sanitized status — NEVER the key, never
    // sessionId/installId, never raw server messages (reasonCode only).
    void refreshIngestKey().then((k) => {
      sendResponse(buildStatusResponse({
        ...statusSnapshot(),
        hasKey: !!k,
        lastStepUpResult,
        version: chrome.runtime.getManifest().version,
      }));
    });
    return true;
  }

  if (message.type === 'browserguard_behavior_snapshot') {
    if (!fromContentScript) return reject(message.type);
    // Le dernier onglet à flusher écrase les données des autres —
    // voir la limitation "snapshot multi-onglet" documentée ci-dessus.
    lastSnapshot = message.snapshot as BehaviorSnapshot;
    return false; // synchronous, no response needed
  }

  if (message.type === 'browserguard_stepup_result') {
    if (!fromStepUpPage) return reject(message.type);
    // Async verdict response — the step-up page waits for the SERVER
    // decision (accepted/rejected) before showing pass/fail.
    void handleStepUpResult(message as StepUpResultMessage).then((v) => sendResponse(v));
    return true;
  }

  if (message.type === 'browserguard_stepup_error') {
    if (!fromStepUpPage) return reject(message.type);
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

// ─── Key-change watchers (Phase 6) ──────────────────────────────────
// Trigger broadcastCollectionState ONLY on these events — NOT on every
// SW wake: freshly loaded content scripts already query the SW on load,
// so a wake-time broadcast would be redundant work on every restart.
export function handleKeyStorageChange(changes: Record<string, unknown>, area: string): void {
  if ((area === 'managed' && MANAGED_KEY_FIELD in changes) ||
      (typeof __BG_DEV__ !== 'undefined' && __BG_DEV__ === true && IS_DEV_BUILD &&
        area === 'local' && DEV_LOCAL_KEY_FIELD in changes)) {
    ingestKey = null; // force re-read at next refresh
    stepUpRequiredPending = false; // a lost key cancels any pending offer
    void broadcastCollectionState(); // refreshes key + recomputes badge
  }
}

if (isServiceWorkerContext) {
  chrome.storage.onChanged.addListener(handleKeyStorageChange);
  chrome.runtime.onStartup.addListener(() => void broadcastCollectionState());
  chrome.runtime.onInstalled.addListener(() => void broadcastCollectionState());
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
    beaconInFlight,
    ingestKey: ingestKey ? `***len${ingestKey.length}` : null,
    serverBackoffUntil,
    serverBackoffStep,
    tenantMismatchRotated,
    stepUpRejectedUntil,
    lastBeaconOkAt,
    consecutiveBeaconFailures,
    stepUpRequiredPending,
    lastStepUpResult,
    isDevBuild: IS_DEV_BUILD,
  };
}

export function __testSetIngestKey(key: string | null): void {
  ingestKey = key;
  // Never expires: tests using vi.useFakeTimers() would otherwise see the
  // cache go stale and block on the storage callback that fake timers
  // never fire.
  ingestKeyFetchedAt = Number.MAX_SAFE_INTEGER;
}

export function __testSetDevBuild(v: boolean): void {
  IS_DEV_BUILD = v;
}

export function __testSetServerBackoff(untilMs: number, step: number): void {
  serverBackoffUntil = untilMs;
  serverBackoffStep = step;
}

export function __testSetStepUpRejected(untilMs: number): void {
  stepUpRejectedUntil = untilMs;
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

export function __testSetBeaconStats(okAt: number, failures: number): void {
  lastBeaconOkAt = okAt;
  consecutiveBeaconFailures = failures;
}

export function __testSetStepUpRequiredPending(v: boolean): void {
  stepUpRequiredPending = v;
}

export function __testSetSnapshot(snap: BehaviorSnapshot | null): void {
  lastSnapshot = snap;
}

export function __testResetStepUp(): void {
  clearStepUpState();
  sessionInvalidated = false;
  consecutivePopupFailures = 0;
  lastPopupFailureAt = 0;
  // Reset Phase 6 key/backoff state so tests don't leak into each other.
  ingestKey = null;
  ingestKeyFetchedAt = 0;
  serverBackoffUntil = 0;
  serverBackoffStep = 0;
  tenantMismatchRotated = false;
  stepUpRejectedUntil = 0;
  lastBeaconOkAt = 0;
  consecutiveBeaconFailures = 0;
  stepUpRequiredPending = false;
  lastStepUpResult = null;
  // Reset in-flight beacon state (audit v0.2.1) — a previous test may
  // have left beaconInFlight=true if the fetch mock never resolved.
  beaconInFlight = false;
  if (beaconAbortController) {
    beaconAbortController.abort();
    beaconAbortController = null;
  }
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

  // Restore status fields persisted in storage.session (last accepted
  // beacon + last step-up verdict) and recompute the badge — otherwise a
  // woken SW would show "connecting" to an idle-but-connected user.
  void restoreSessionStatus();

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
