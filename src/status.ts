/**
 * BrowserGuard — status model (pure logic, no chrome.* APIs).
 *
 * Maps the service worker's internal state to the 4+1 badge levels and
 * to the sanitized object returned to the popup via
 * `browserguard_status_query`. NO secrets ever transit through this
 * module: no ingest key, no sessionId/installId, no proofToken.
 *
 * Levels (priority order, first match wins):
 *   inactive   — no provisioned ingest key (SANS CLE = RIEN)
 *   error      — session invalidated, server backoff, or ≥3 failed sends
 *   attention  — a step-up is required or in progress
 *   connecting — key present, no beacon ACCEPTED yet (lastBeaconOkAt===0)
 *   active     — a beacon was accepted (HTTP 200) within the last 60 s
 *   idle       — accepted before but quiet >60 s (beacons only fire on
 *                activity; an idle user simply doesn't emit)
 *
 * consecutiveBeaconFailures only counts fetches that actually LEFT the
 * browser and failed — skipped sends (no key, backoff, no snapshot,
 * step-up in progress, invalidated) never count.
 */

export type StatusLevel =
  | 'inactive' | 'error' | 'attention' | 'connecting' | 'active' | 'idle';

/** Window in which a last accepted beacon still counts as "active". */
export const ACTIVE_WINDOW_MS = 60_000;
/** Consecutive failed sends before the badge goes red on its own. */
export const FAILURE_THRESHOLD = 3;

export interface InternalState {
  hasKey: boolean;
  lastBeaconOkAt: number;            // 0 = no beacon accepted yet
  consecutiveBeaconFailures: number; // real fetch failures only
  stepUpRequiredPending: boolean;
  stepUpInProgress: boolean;
  serverBackoffUntil: number;
  sessionInvalidated: boolean;
  now: number;
}

export interface StatusView {
  level: StatusLevel;
  badgeText: string;
  badgeColor: string;
  reasonCode: string;   // internal code — popup translates via i18n
  titleKey: string;     // i18n key for the full sentence
}

export function computeStatus(s: InternalState): StatusView {
  if (!s.hasKey) {
    return { level: 'inactive', badgeText: 'OFF', badgeColor: '#64748b', reasonCode: 'no_key', titleKey: 'status.no_key' };
  }
  if (s.sessionInvalidated) {
    return { level: 'error', badgeText: 'ERR', badgeColor: '#dc2626', reasonCode: 'session_invalidated', titleKey: 'status.session_invalidated' };
  }
  if (s.now < s.serverBackoffUntil) {
    return { level: 'error', badgeText: 'ERR', badgeColor: '#dc2626', reasonCode: 'server_backoff', titleKey: 'status.server_backoff' };
  }
  if (s.consecutiveBeaconFailures >= FAILURE_THRESHOLD) {
    return { level: 'error', badgeText: 'ERR', badgeColor: '#dc2626', reasonCode: 'beacon_failures', titleKey: 'status.beacon_failures' };
  }
  if (s.stepUpInProgress || s.stepUpRequiredPending) {
    return { level: 'attention', badgeText: '!', badgeColor: '#d97706', reasonCode: 'stepup_pending', titleKey: 'status.stepup' };
  }
  if (s.lastBeaconOkAt === 0) {
    return { level: 'connecting', badgeText: '…', badgeColor: '#64748b', reasonCode: 'connecting', titleKey: 'status.connecting' };
  }
  if (s.now - s.lastBeaconOkAt <= ACTIVE_WINDOW_MS) {
    return { level: 'active', badgeText: 'ON', badgeColor: '#16a34a', reasonCode: 'active', titleKey: 'status.active' };
  }
  return { level: 'idle', badgeText: 'IDLE', badgeColor: '#64748b', reasonCode: 'idle', titleKey: 'status.idle' };
}

// ─── Last step-up result (storage.session, no secrets) ──────────────

export interface LastStepUpResult {
  at: number;            // epoch ms
  success: boolean;      // iframe decision was GO-like AND server accepted
  decision: string;      // 'GO' | 'NO-GO' | 'INSUFFICIENT_CONFIDENCE' | …
}

// ─── Sanitized status response for the popup ────────────────────────
// SECURITY CONTRACT: this object is sent to the extension popup page.
// It must NEVER carry secrets: no ingest key, no sessionId, no
// installId, no proofToken, no tenant identifier. Fields are
// deliberately primitive (booleans, codes, timestamps, version string).

/** One entry of the local proof history: public proof identifiers only. */
export interface StatusDecisionEntry {
  decisionId: string; // public GateGuard decision UUID (proof page id)
  outcome: string;    // 'GO' | 'NO-GO' | 'INSUFFICIENT_CONFIDENCE' | …
  at: number;         // epoch ms
}

export interface StatusResponse {
  level: StatusLevel;
  reasonCode: string;
  collectionEnabled: boolean;
  serverBackoffRemainingMs: number;
  lastStepUpAt: number | null;
  lastStepUpSuccess: boolean | null;
  lastStepUpDecision: string | null;
  version: string;
  // Public proof identifiers (decision UUID + outcome + timestamp). The
  // decisionId is NOT a secret: /proof/:id is a public, rate-limited view
  // exposing no identity data. No userId, tenant or page data.
  decisionHistory: StatusDecisionEntry[];
}

export function buildStatusResponse(s: InternalState & {
  lastStepUpResult: LastStepUpResult | null;
  version: string;
  decisionHistory?: StatusDecisionEntry[];
}): StatusResponse {
  const view = computeStatus(s);
  return {
    level: view.level,
    reasonCode: view.reasonCode,
    collectionEnabled: s.hasKey,
    serverBackoffRemainingMs: Math.max(0, s.serverBackoffUntil - s.now),
    lastStepUpAt: s.lastStepUpResult?.at ?? null,
    lastStepUpSuccess: s.lastStepUpResult?.success ?? null,
    lastStepUpDecision: s.lastStepUpResult?.decision ?? null,
    version: s.version,
    decisionHistory: s.decisionHistory ?? [],
  };
}
