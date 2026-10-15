/**
 * BrowserGuard - decision proof link + local history.
 * ─────────────────────────────────────────────────────────────────────────────
 * After a GateGuard step-up ends, the user gets a neutral link to the public
 * proof page of the decision (GO and refusal alike - every finalized decision
 * gets an anchored receipt server-side).
 *
 * decisionId plumbing: GateGuard /session/finalize returns `decisionId` equal
 * to the GateGuard session UUID (decision_receipts.decision_id). embed.js
 * does not relay a `decisionId` field but posts `sessionId`, the SAME value,
 * inside `browserguard_stepup_result`. The extension therefore uses
 * result.sessionId as the decisionId, guarded by an UUID shape check.
 *
 * This module NEVER calls /proof/:decisionId/opening (identity data).
 *
 * @copyright (c) 2026 Benjamin BARRERE / IA SOLUTION
 * @license Patents Pending FR2514274 | FR2514546
 */

// Build-time step-up host (same origin serves /embed/ and /proof/).
// Dev builds redefine it to the local GateGuard; the production literal is
// the default. The PUBLIC proof domain is not final - it lives in this ONE
// constant so a domain change is a single-line edit.
declare const __BG_STEPUP_BASE__: string;
export const PROOF_PAGE_BASE: string =
  typeof __BG_STEPUP_BASE__ === 'string' ? __BG_STEPUP_BASE__ : 'https://challenge.hcs-u7.org';

// decision_receipts.decision_id is the finalized session UUID - mirror of
// the server-side guard in gateguard-service/src/proof-routes.ts.
const UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isDecisionId(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

/** Public proof page URL, or null when the id is not a decision UUID. */
export function buildProofUrl(decisionId: unknown): string | null {
  return isDecisionId(decisionId) ? `${PROOF_PAGE_BASE}/proof/?id=${decisionId}` : null;
}

// ─── Local decision history (chrome.storage.local) ──────────────────
// Privacy contract: decisionId (random UUID), outcome (controlled
// vocabulary) and timestamp ONLY - no userId, no tenant, no page data.

export interface DecisionRecord {
  decisionId: string;
  outcome: string; // GateGuard decision: 'GO' | 'NO-GO' | 'INSUFFICIENT_CONFIDENCE' | …
  at: number;      // epoch ms
}

export const DECISION_HISTORY_KEY = 'browserguard_decisionHistory';
export const DECISION_HISTORY_MAX = 10;

// Outcome is a controlled vocabulary, never free text.
const OUTCOME_RE = /^[A-Z][A-Z_-]{0,31}$/;

/** Validates data read back from storage - drops malformed entries. */
export function sanitizeHistory(v: unknown): DecisionRecord[] {
  if (!Array.isArray(v)) return [];
  const out: DecisionRecord[] = [];
  for (const item of v) {
    if (!item || typeof item !== 'object') continue;
    const r = item as Record<string, unknown>;
    if (!isDecisionId(r.decisionId)) continue;
    if (typeof r.outcome !== 'string' || !OUTCOME_RE.test(r.outcome)) continue;
    if (typeof r.at !== 'number' || !Number.isFinite(r.at)) continue;
    out.push({ decisionId: r.decisionId, outcome: r.outcome, at: r.at });
    if (out.length >= DECISION_HISTORY_MAX) break;
  }
  return out;
}

/** Newest first, de-duplicated by decisionId, capped at DECISION_HISTORY_MAX. */
export function appendDecisionRecord(
  list: DecisionRecord[],
  rec: DecisionRecord,
): DecisionRecord[] {
  return [rec, ...list.filter((r) => r.decisionId !== rec.decisionId)]
    .slice(0, DECISION_HISTORY_MAX);
}

export function readDecisionHistory(): Promise<DecisionRecord[]> {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(DECISION_HISTORY_KEY, (res) => {
        resolve(sanitizeHistory(res?.[DECISION_HISTORY_KEY]));
      });
    } catch {
      resolve([]);
    }
  });
}

/** Read-modify-write the history. Never throws - best effort. */
export function recordDecisionProof(rec: DecisionRecord): Promise<void> {
  return readDecisionHistory()
    .then((list) => {
      try {
        chrome.storage.local.set({ [DECISION_HISTORY_KEY]: appendDecisionRecord(list, rec) });
      } catch { /* storage unavailable */ }
    })
    .catch(() => { /* never let bookkeeping break the step-up flow */ });
}
