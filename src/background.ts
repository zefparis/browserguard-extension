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
  if (!lastSnapshot || lastSnapshot.totalEvents === 0) return;
  if (stepUpInProgress) return; // pause beacons during step-up

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

    // Check for step-up requirement
    if (data.step_up_required === true && data.step_up_url && !stepUpInProgress) {
      triggerStepUp(data.step_up_url);
    }
  } catch (err) {
    console.error('[BrowserGuard] Beacon error:', err);
  }
}

// ─── Step-up trigger ────────────────────────────────────────────────

function triggerStepUp(stepUpUrl: string): void {
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
    }
  });
}

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
  } catch (err) {
    console.error('[BrowserGuard] Failed to notify backend of step-up result:', err);
  }

  stepUpInProgress = false;
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
    console.error('[BrowserGuard] Step-up error:', (message as StepUpErrorMessage).error, (message as StepUpErrorMessage).detail);
    stepUpInProgress = false;
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
  if (beaconTimer) clearInterval(beaconTimer);
});
