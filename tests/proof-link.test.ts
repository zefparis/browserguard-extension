/**
 * Proof link feature - unit tests.
 * Covers: decisionId UUID validation, proof URL building, history
 * append/dedupe/cap, storage sanitization, SW-side recording via
 * handleStepUpResult, and the sanitized status channel payload.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import './chrome-mock';
import { resetChromeMock } from './chrome-mock';

import {
  isDecisionId,
  buildProofUrl,
  sanitizeHistory,
  appendDecisionRecord,
  recordDecisionProof,
  readDecisionHistory,
  DECISION_HISTORY_KEY,
  DECISION_HISTORY_MAX,
  PROOF_PAGE_BASE,
  type DecisionRecord,
} from '../src/proof-link';

import {
  handleStepUpResult,
  __testResetStepUp,
  __testSetIngestKey,
  __testSetSessionId,
  type StepUpResultMessage,
} from '../src/background';

import { buildStatusResponse, type InternalState } from '../src/status';

const UUID_1 = '11111111-2222-4333-8444-555566667777';
const UUID_2 = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const UUID_3 = '00000000-1111-4222-8333-444444444444';
const GG_NON_UUID = 'gg_different_session_id';

const TEST_KEY = 'a'.repeat(64);

function makeResult(overrides: Partial<StepUpResultMessage> = {}): StepUpResultMessage {
  return {
    type: 'browserguard_stepup_result',
    decision: 'GO',
    score: 85,
    confidence: 0.9,
    engaged: true,
    reason: 'test',
    sessionId: UUID_1,
    completedCount: 5,
    plannedCount: 5,
    proofToken: null,
    ...overrides,
  };
}

function rec(id: string, outcome = 'GO', at = 1000): DecisionRecord {
  return { decisionId: id, outcome, at };
}

// The mock's storage area keeps data in a private object - read it back
// through the public get() API instead of internal state.
function readRaw(key: string): Promise<any> {
  return new Promise((resolve) => {
    chrome.storage.local.get(key, (r: any) => resolve(r?.[key]));
  });
}

describe('isDecisionId', () => {
  it('accepts UUID v4 shape (any variant nibble)', () => {
    expect(isDecisionId(UUID_1)).toBe(true);
    expect(isDecisionId(UUID_2)).toBe(true);
    expect(isDecisionId(UUID_3)).toBe(true);
    expect(isDecisionId(UUID_1.toUpperCase())).toBe(true);
  });

  it('rejects BrowserGuard sessionIds, GateGuard strings and junk', () => {
    expect(isDecisionId(GG_NON_UUID)).toBe(false);
    expect(isDecisionId('bg_1234567890_abcdefgh')).toBe(false);
    expect(isDecisionId('')).toBe(false);
    expect(isDecisionId('11111111-2222-4333-8444-55556666777')).toBe(false);  // 1 short
    expect(isDecisionId('11111111-2222-4333-8444-5555666677770')).toBe(false); // 1 long
    expect(isDecisionId('gggggggg-2222-4333-8444-555566667777')).toBe(false); // non-hex
    expect(isDecisionId('x' + UUID_1)).toBe(false);                          // anchored
    expect(isDecisionId(UUID_1 + '?evil=1')).toBe(false);                    // injection
    expect(isDecisionId(123)).toBe(false);
    expect(isDecisionId(null)).toBe(false);
    expect(isDecisionId(undefined)).toBe(false);
  });
});

describe('buildProofUrl', () => {
  it('builds the public proof URL on the single base constant', () => {
    expect(buildProofUrl(UUID_1)).toBe(`${PROOF_PAGE_BASE}/proof/?id=${UUID_1}`);
    // Fallback literal when no build-time define is injected (vitest).
    expect(PROOF_PAGE_BASE).toBe('https://challenge.hcs-u7.org');
  });

  it('returns null for non-UUID input - link never built from junk', () => {
    expect(buildProofUrl(GG_NON_UUID)).toBeNull();
    expect(buildProofUrl('bg_123')).toBeNull();
    expect(buildProofUrl(undefined)).toBeNull();
  });
});

describe('appendDecisionRecord', () => {
  it('prepends newest first', () => {
    const list = appendDecisionRecord([rec(UUID_1)], rec(UUID_2, 'NO-GO', 2000));
    expect(list.map((r) => r.decisionId)).toEqual([UUID_2, UUID_1]);
    expect(list[0].outcome).toBe('NO-GO');
  });

  it('dedupes by decisionId - latest occurrence wins', () => {
    let list = appendDecisionRecord([], rec(UUID_1, 'GO', 1000));
    list = appendDecisionRecord(list, rec(UUID_2, 'NO-GO', 2000));
    list = appendDecisionRecord(list, rec(UUID_1, 'NO-GO', 3000));
    expect(list).toHaveLength(2);
    expect(list[0]).toEqual(rec(UUID_1, 'NO-GO', 3000));
    expect(list[1].decisionId).toBe(UUID_2);
  });

  it('caps at DECISION_HISTORY_MAX', () => {
    let list: DecisionRecord[] = [];
    for (let i = 0; i < DECISION_HISTORY_MAX + 5; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      list = appendDecisionRecord(list, rec(id, 'GO', i));
    }
    expect(list).toHaveLength(DECISION_HISTORY_MAX);
    expect(list[0].at).toBe(DECISION_HISTORY_MAX + 4); // newest kept
  });
});

describe('sanitizeHistory', () => {
  it('returns [] for non-array input', () => {
    expect(sanitizeHistory(undefined)).toEqual([]);
    expect(sanitizeHistory('x')).toEqual([]);
    expect(sanitizeHistory({})).toEqual([]);
  });

  it('drops malformed entries and keeps valid ones', () => {
    const out = sanitizeHistory([
      rec(UUID_1),
      { decisionId: 'not-a-uuid', outcome: 'GO', at: 1 },
      { decisionId: UUID_2, outcome: 'free text!', at: 2 },
      { decisionId: UUID_2, outcome: 'GO' },                 // missing at
      { decisionId: UUID_2, outcome: 'GO', at: 'now' },      // bad at type
      { decisionId: UUID_2, outcome: 'go', at: 3 },          // lowercase outcome
      { decisionId: UUID_3, outcome: 'INSUFFICIENT_CONFIDENCE', at: 4 },
      'garbage',
      null,
    ]);
    expect(out).toEqual([
      rec(UUID_1),
      { decisionId: UUID_3, outcome: 'INSUFFICIENT_CONFIDENCE', at: 4 },
    ]);
  });
});

describe('recordDecisionProof + readDecisionHistory (chrome.storage.local)', () => {
  beforeEach(() => {
    resetChromeMock();
  });

  it('records a decision and reads it back sanitized', async () => {
    await recordDecisionProof(rec(UUID_1, 'GO', 1234));
    const list = await readDecisionHistory();
    expect(list).toEqual([{ decisionId: UUID_1, outcome: 'GO', at: 1234 }]);
  });

  it('keeps only the last DECISION_HISTORY_MAX entries', async () => {
    for (let i = 0; i < 12; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      await recordDecisionProof(rec(id, i % 2 ? 'NO-GO' : 'GO', i));
    }
    const list = await readDecisionHistory();
    expect(list).toHaveLength(DECISION_HISTORY_MAX);
    expect(list[0].at).toBe(11);
    expect(list[list.length - 1].at).toBe(2);
  });

  it('stores only decisionId, outcome and at - nothing personal', async () => {
    await recordDecisionProof(rec(UUID_1, 'NO-GO', 999));
    const raw = await readRaw(DECISION_HISTORY_KEY);
    expect(Object.keys(raw[0]).sort()).toEqual(['at', 'decisionId', 'outcome']);
  });
});

describe('handleStepUpResult - proof recording', () => {
  beforeEach(() => {
    resetChromeMock();
    vi.restoreAllMocks();
    __testSetSessionId('bg_1234567890_abcdefgh');
    __testResetStepUp();
    __testSetIngestKey(TEST_KEY);
  });

  it('records decisionId + outcome for a GO verdict', async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    await handleStepUpResult(makeResult({ decision: 'GO', sessionId: UUID_1 }));
    // recordDecisionProof is fire-and-forget over async storage - flush.
    await new Promise((r) => setTimeout(r, 10));
    const list = await readDecisionHistory();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ decisionId: UUID_1, outcome: 'GO' });
  });

  it('records a refusal too - a NO-GO also gets an anchored receipt', async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    await handleStepUpResult(makeResult({ decision: 'NO-GO', sessionId: UUID_2 }));
    await new Promise((r) => setTimeout(r, 10));
    const list = await readDecisionHistory();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ decisionId: UUID_2, outcome: 'NO-GO' });
  });

  it('records even when the server rejects the result - receipt still exists', async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: false, status: 403, json: async () => ({ error: 'PROOF_INVALID' }),
    });
    await handleStepUpResult(makeResult({ decision: 'GO', sessionId: UUID_3 }));
    await new Promise((r) => setTimeout(r, 10));
    const list = await readDecisionHistory();
    expect(list).toHaveLength(1);
    expect(list[0].decisionId).toBe(UUID_3);
  });

  it('records nothing when sessionId is not a decision UUID', async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    await handleStepUpResult(makeResult({ sessionId: GG_NON_UUID }));
    await new Promise((r) => setTimeout(r, 10));
    const list = await readDecisionHistory();
    expect(list).toEqual([]);
  });
});

describe('buildStatusResponse - decisionHistory channel', () => {
  const base: InternalState = {
    hasKey: true,
    lastBeaconOkAt: 1000,
    consecutiveBeaconFailures: 0,
    stepUpRequiredPending: false,
    stepUpInProgress: false,
    serverBackoffUntil: 0,
    sessionInvalidated: false,
    now: 10_000,
  };

  it('defaults to an empty array', () => {
    const resp = buildStatusResponse({ ...base, lastStepUpResult: null, version: '0.0.0' });
    expect(resp.decisionHistory).toEqual([]);
  });

  it('passes through the sanitized history - no extra fields', () => {
    const history = [{ decisionId: UUID_1, outcome: 'GO', at: 5 }];
    const resp = buildStatusResponse({
      ...base,
      lastStepUpResult: null,
      version: '0.0.0',
      decisionHistory: history,
    });
    expect(resp.decisionHistory).toEqual(history);
    // The serialized payload carries no sessionId, key or proofToken.
    const json = JSON.stringify(resp);
    expect(json).not.toContain('proofToken');
    expect(json).not.toContain('ingestKey');
    expect(json).not.toContain('sessionId');
    expect(json).not.toContain('installId');
  });
});
