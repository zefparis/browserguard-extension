/**
 * BrowserGuard — Content Script (passive behavioral capture)
 * ─────────────────────────────────────────────────────────────────────────────
 * Captures keystroke, mouse, and scroll events passively. Zero interaction
 * visible to the user — no UI, no overlays, no DOM modifications.
 *
 * Events are aggregated in-memory and flushed to the service worker
 * (background.ts) every FLUSH_INTERVAL_MS via chrome.runtime.sendMessage.
 * The service worker handles the periodic beacon to the backend.
 *
 * @copyright (c) 2026 Benjamin BARRERE / IA SOLUTION
 * @license Patents Pending FR2514274 | FR2514546
 */

// Named exports are used by vitest; esbuild bundles this entry point
// into a standalone IIFE, so they have no runtime effect in production.

// ─── Config ─────────────────────────────────────────────────────────

const FLUSH_INTERVAL_MS = 5_000; // flush to service worker every 5s
const MAX_EVENTS_PER_TYPE = 500; // cap to prevent memory blowup

// ─── Types ──────────────────────────────────────────────────────────

interface KeystrokeEvent {
  timestamp: number;
  duration: number; // key hold time
}

interface CapturedMouseEvent {
  timestamp: number;
  x: number;
  y: number;
}

interface ScrollEvent {
  timestamp: number;
  scrollY: number;
}

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
  viewportWidth: number;
  viewportHeight: number;
  pixelRatio: number;
  // ── Diagnostic fields (think-time cadence calibration) ──
  // NOT scored by computeDivergence or any risk engine. Collected passively
  // for offline calibration against black-box attack data. See analysis:
  // "Think-time cadence" — burst/silence pattern of vision agents.
  // null when < 2 events in the window (not calculable, not 0).
  burstRatio: number | null;
  interEventGapStd: number | null;
}

// ─── State ──────────────────────────────────────────────────────────

const keystrokes: KeystrokeEvent[] = [];
const mouseEvents: CapturedMouseEvent[] = [];
const scrollEvents: ScrollEvent[] = [];

let lastKeystrokeTime = 0;
let lastMouseTime = 0;
let lastMouseX = 0;
let lastMouseY = 0;
let lastScrollTime = 0;
let lastScrollY = 0;
let mousePauseCount = 0;
let scrollPauseCount = 0;

let lastMouseMoveTime = 0;
let mouseSpeeds: number[] = [];
let mouseCurvatures: number[] = [];
let scrollSpeeds: number[] = [];

// ─── Collection gating (Phase 6 — SANS CLE = RIEN) ──────────────────
// The content script NEVER reads the ingest key. It asks the service
// worker whether collection is allowed (browserguard_collection_query)
// and obeys browserguard_collection_state broadcasts pushed by the SW
// when the provisioned key appears or disappears. Until enabled, NO
// DOM listener is attached — nothing is captured, buffered, or sent.

let collectionEnabled = false;
let listenersAttached = false;

// ─── Keystroke capture ──────────────────────────────────────────────

let keyDownTime = 0;

const onKeydown = (e: KeyboardEvent) => {
  // SECURITY: reject synthetic events dispatched by the page via
  // dispatchEvent(). isTrusted is set by the browser and cannot be
  // forged — only real user-generated events have isTrusted=true.
  // Without this check, a malicious page sharing the DOM with this
  // content script can forge a "perfect human" behavioral profile.
  if (!e.isTrusted) return;
  keyDownTime = performance.now();
};

const onKeyup = (e: KeyboardEvent) => {
  // SECURITY: reject synthetic events (see keydown handler above).
  if (!e.isTrusted) return;
  if (keyDownTime === 0) return;
  const now = performance.now();
  const holdDuration = now - keyDownTime;

  if (lastKeystrokeTime > 0) {
    if (keystrokes.length < MAX_EVENTS_PER_TYPE) {
      keystrokes.push({ timestamp: now, duration: holdDuration });
    }
  }
  lastKeystrokeTime = now;
  keyDownTime = 0;
};

// ─── Mouse capture ──────────────────────────────────────────────────

let prevMouseMove: { x: number; y: number; t: number } | null = null;
let prevPrevMouseMove: { x: number; y: number; t: number } | null = null;

const onMousemove = (e: MouseEvent) => {
  // SECURITY: reject synthetic events (see keydown handler above).
  if (!e.isTrusted) return;
  const now = performance.now();
  const evt = { timestamp: now, x: e.clientX, y: e.clientY };

  if (mouseEvents.length < MAX_EVENTS_PER_TYPE) {
    mouseEvents.push(evt);
  }

  // Speed calculation
  if (prevMouseMove) {
    const dt = now - prevMouseMove.t;
    if (dt > 0) {
      const dx = e.clientX - prevMouseMove.x;
      const dy = e.clientY - prevMouseMove.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const speed = dist / dt; // px per ms
      if (mouseSpeeds.length < MAX_EVENTS_PER_TYPE) {
        mouseSpeeds.push(speed);
      }

      // Curvature: angle change between prev-prev → prev and prev → current
      if (prevPrevMouseMove) {
        const v1x = prevMouseMove.x - prevPrevMouseMove.x;
        const v1y = prevMouseMove.y - prevPrevMouseMove.y;
        const v2x = e.clientX - prevMouseMove.x;
        const v2y = e.clientY - prevMouseMove.y;
        const cross = v1x * v2y - v1y * v2x;
        const dot = v1x * v2x + v1y * v2y;
        const angle = Math.abs(Math.atan2(cross, dot));
        if (mouseCurvatures.length < MAX_EVENTS_PER_TYPE) {
          mouseCurvatures.push(angle);
        }
      }
    }

    // Pause detection: > 500ms between moves
    if (now - prevMouseMove.t > 500) {
      mousePauseCount++;
    }
  }

  prevPrevMouseMove = prevMouseMove;
  prevMouseMove = { x: e.clientX, y: e.clientY, t: now };
  lastMouseTime = now;
};

// ─── Scroll capture ─────────────────────────────────────────────────

const onScroll = (e: Event) => {
  // SECURITY: reject synthetic events (see keydown handler above).
  if (!e.isTrusted) return;
  const now = performance.now();
  const sy = window.scrollY;

  if (scrollEvents.length < MAX_EVENTS_PER_TYPE) {
    scrollEvents.push({ timestamp: now, scrollY: sy });
  }

  if (lastScrollTime > 0) {
    const dt = now - lastScrollTime;
    if (dt > 0) {
      const dy = Math.abs(sy - lastScrollY);
      const speed = dy / dt;
      if (scrollSpeeds.length < MAX_EVENTS_PER_TYPE) {
        scrollSpeeds.push(speed);
      }
    }
    if (now - lastScrollTime > 500) {
      scrollPauseCount++;
    }
  }

  lastScrollY = sy;
  lastScrollTime = now;
};

// ─── Listener lifecycle (Phase 6) ───────────────────────────────────

function resetAccumulators(): void {
  keystrokes.length = 0;
  mouseEvents.length = 0;
  scrollEvents.length = 0;
  mouseSpeeds = [];
  mouseCurvatures = [];
  scrollSpeeds = [];
  mousePauseCount = 0;
  scrollPauseCount = 0;
  lastKeystrokeTime = 0;
  lastScrollTime = 0;
  lastScrollY = 0;
  keyDownTime = 0;
  prevMouseMove = null;
  prevPrevMouseMove = null;
}

export function enableCollection(): void {
  if (listenersAttached) return;
  document.addEventListener('keydown', onKeydown, { passive: true });
  document.addEventListener('keyup', onKeyup, { passive: true });
  document.addEventListener('mousemove', onMousemove, { passive: true });
  document.addEventListener('scroll', onScroll, { passive: true });
  listenersAttached = true;
  collectionEnabled = true;
}

export function disableCollection(): void {
  if (!listenersAttached) return;
  document.removeEventListener('keydown', onKeydown);
  document.removeEventListener('keyup', onKeyup);
  document.removeEventListener('mousemove', onMousemove);
  document.removeEventListener('scroll', onScroll);
  listenersAttached = false;
  collectionEnabled = false;
  resetAccumulators(); // drop any partial window
}

export function __testGetCollectionState(): { enabled: boolean; listenersAttached: boolean; keystrokes: number; mouseEvents: number; scrollEvents: number } {
  return {
    enabled: collectionEnabled,
    listenersAttached,
    keystrokes: keystrokes.length,
    mouseEvents: mouseEvents.length,
    scrollEvents: scrollEvents.length,
  };
}

// ─── Aggregate & flush ──────────────────────────────────────────────

function computeStats(arr: number[]): { avg: number | null; variance: number | null } {
  if (arr.length === 0) return { avg: null, variance: null };
  const avg = arr.reduce((s, v) => s + v, 0) / arr.length;
  const variance = arr.reduce((s, v) => s + (v - avg) ** 2, 0) / arr.length;
  return { avg, variance };
}

/**
 * Diagnostic: compute burstRatio and interEventGapStd from all event
 * timestamps in the current window. These are NOT scored — collected
 * for offline calibration of think-time cadence detection.
 *
 * - burstRatio: (lastEvent - firstEvent) / FLUSH_INTERVAL_MS. Measures
 *   what fraction of the 5s window contained actual activity. A vision
 *   agent that acts for 1.5s then waits 3.5s → burstRatio ≈ 0.3.
 *   A human interacting continuously → burstRatio ≈ 0.9.
 * - interEventGapStd: standard deviation of inter-event gaps (ms).
 *   A burst-then-silence pattern produces high std (few ms during burst,
 *   several seconds during silence). Continuous interaction → low std.
 *
 * Returns { null, null } when < 2 events (not calculable).
 */
function computeCadenceDiagnostics(): {
  burstRatio: number | null;
  interEventGapStd: number | null;
} {
  // Collect all timestamps from the three event arrays
  const allTimestamps: number[] = [];
  for (const k of keystrokes) allTimestamps.push(k.timestamp);
  for (const m of mouseEvents) allTimestamps.push(m.timestamp);
  for (const s of scrollEvents) allTimestamps.push(s.timestamp);

  if (allTimestamps.length < 2) {
    return { burstRatio: null, interEventGapStd: null };
  }

  allTimestamps.sort((a, b) => a - b);

  const firstTs = allTimestamps[0];
  const lastTs = allTimestamps[allTimestamps.length - 1];
  const activeSpan = lastTs - firstTs;
  const burstRatio = Math.min(1, activeSpan / FLUSH_INTERVAL_MS);

  // Inter-event gaps
  const gaps: number[] = [];
  for (let i = 1; i < allTimestamps.length; i++) {
    gaps.push(allTimestamps[i] - allTimestamps[i - 1]);
  }
  const gapMean = gaps.reduce((s, v) => s + v, 0) / gaps.length;
  const gapVariance = gaps.reduce((s, v) => s + (v - gapMean) ** 2, 0) / gaps.length;
  const interEventGapStd = Math.sqrt(gapVariance);

  return {
    burstRatio: Math.round(burstRatio * 1000) / 1000,
    interEventGapStd: Math.round(interEventGapStd * 100) / 100,
  };
}

function buildSnapshot(): BehaviorSnapshot {
  // Keystroke intervals
  const keystrokeIntervals: number[] = [];
  for (let i = 1; i < keystrokes.length; i++) {
    keystrokeIntervals.push(keystrokes[i].timestamp - keystrokes[i - 1].timestamp);
  }
  const keystrokeHolds = keystrokes.map((k) => k.duration);

  const cadenceDiag = computeCadenceDiagnostics();

  return {
    keystrokeIntervals,
    keystrokeHolds,
    keystrokeCount: keystrokes.length,
    mouseSpeeds,
    mouseCurvatures,
    mousePauseCount,
    mouseEventCount: mouseEvents.length,
    scrollSpeeds,
    scrollPauseCount,
    scrollEventCount: scrollEvents.length,
    totalEvents: keystrokes.length + mouseEvents.length + scrollEvents.length,
    timestamp: new Date().toISOString(),
    viewportWidth: window.innerWidth,
    viewportHeight: window.innerHeight,
    pixelRatio: window.devicePixelRatio || 1,
    // Diagnostic (think-time cadence calibration) — NOT scored
    burstRatio: cadenceDiag.burstRatio,
    interEventGapStd: cadenceDiag.interEventGapStd,
  };
}

export function flush(): void {
  // SANS CLE = RIEN: no capture window while collection is disabled —
  // don't even send an empty snapshot.
  if (!collectionEnabled) return;
  const snapshot = buildSnapshot();

  // Send to service worker
  try {
    chrome.runtime.sendMessage({
      type: 'browserguard_behavior_snapshot',
      snapshot,
      timestamp: Date.now(),
    });
  } catch {
    // Service worker may be inactive — silently ignore
  }

  // Reset all accumulators so the next snapshot reflects only the next
  // 5s window. Previously only mouseSpeeds/mouseCurvatures were reset,
  // causing keystrokes/mouseEvents/scrollEvents/scrollSpeeds/pauseCounts
  // to accumulate across windows — sending cumulative counts to the
  // server instead of per-window counts.
  resetAccumulators();
}

// ─── Init (page context only — skipped under vitest) ────────────────
// The whole lifecycle is a function so tests can invoke it after
// installing their own chrome/document stubs.
export function initContentScript(): void {
  // Ask the service worker whether collection is allowed. If the SW is
  // dead or doesn't answer, stay disabled (fail closed — SANS CLE = RIEN).
  try {
    chrome.runtime.sendMessage({ type: 'browserguard_collection_query' }, (resp) => {
      if (chrome.runtime.lastError) return; // SW unreachable — stay disabled
      if (resp?.collectionEnabled) enableCollection();
    });
  } catch {
    // SW unreachable — stay disabled
  }

  // Obey state broadcasts from the SW when the key appears/disappears.
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'browserguard_collection_state') {
      if (msg.enabled) enableCollection();
      else disableCollection();
    }
  });

  // Flush periodically (no-op while collection is disabled)
  setInterval(flush, FLUSH_INTERVAL_MS);

  // Flush on page unload
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      flush();
    }
  }, { passive: true });
}

if (typeof document !== 'undefined' && typeof chrome !== 'undefined' && chrome.runtime?.id) {
  initContentScript();
}
