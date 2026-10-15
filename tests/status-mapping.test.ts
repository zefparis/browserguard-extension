/**
 * Phase 6b — status model tests.
 * Covers: computeStatus matrix (6 levels + priorities), buildStatusResponse
 * secret-freeness, sender guards on runtime messages, stepUpRequiredPending
 * reset matrix, server-verdict combination, storage.session restore.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import './chrome-mock';
import { resetChromeMock, setManagedData, setSessionData, getSessionData } from './chrome-mock';

import {
  computeStatus,
  buildStatusResponse,
  type InternalState,
} from '../src/status';

import {
  onRuntimeMessage,
  handleStepUpResult,
  restoreSessionStatus,
  statusSnapshot,
  __testResetStepUp,
  __testSetIngestKey,
  __testSetBeaconStats,
  __testSetStepUpRequiredPending,
  type StepUpResultMessage,
} from '../src/background';

const TEST_KEY = 'a'.repeat(64);

// ─── computeStatus matrix ───────────────────────────────────────────

function base(over: Partial<InternalState> = {}): InternalState {
  return {
    hasKey: true,
    lastBeaconOkAt: 1_000,
    consecutiveBeaconFailures: 0,
    stepUpRequiredPending: false,
    stepUpInProgress: false,
    serverBackoffUntil: 0,
    sessionInvalidated: false,
    now: 10_000,
    ...over,
  };
}

describe('computeStatus', () => {
  it('no key → inactive (highest priority)', () => {
    const v = computeStatus(base({ hasKey: false, sessionInvalidated: true, stepUpInProgress: true }));
    expect(v.level).toBe('inactive');
    expect(v.badgeText).toBe('OFF');
    expect(v.reasonCode).toBe('no_key');
  });

  it('session invalidated → error', () => {
    expect(computeStatus(base({ sessionInvalidated: true })).level).toBe('error');
    expect(computeStatus(base({ sessionInvalidated: true })).reasonCode).toBe('session_invalidated');
  });

  it('server backoff active → error', () => {
    const v = computeStatus(base({ serverBackoffUntil: 20_000, now: 10_000 }));
    expect(v.level).toBe('error');
    expect(v.reasonCode).toBe('server_backoff');
  });

  it('≥3 consecutive real fetch failures → error', () => {
    expect(computeStatus(base({ consecutiveBeaconFailures: 3 })).level).toBe('error');
    expect(computeStatus(base({ consecutiveBeaconFailures: 2 })).level).not.toBe('error');
  });

  it('step-up in progress → attention', () => {
    const v = computeStatus(base({ stepUpInProgress: true }));
    expect(v.level).toBe('attention');
    expect(v.badgeText).toBe('!');
  });

  it('step-up pending (offer received, popup not yet open) → attention', () => {
    expect(computeStatus(base({ stepUpRequiredPending: true })).level).toBe('attention');
  });

  it('error outranks attention: backoff + pending → error', () => {
    const v = computeStatus(base({ serverBackoffUntil: 99_999, stepUpRequiredPending: true }));
    expect(v.level).toBe('error');
  });

  it('key present but never an accepted beacon → connecting', () => {
    const v = computeStatus(base({ lastBeaconOkAt: 0 }));
    expect(v.level).toBe('connecting');
    expect(v.reasonCode).toBe('connecting');
  });

  it('accepted beacon ≤60s ago → active', () => {
    const v = computeStatus(base({ lastBeaconOkAt: 9_500, now: 10_000 }));
    expect(v.level).toBe('active');
    expect(v.badgeText).toBe('ON');
  });

  it('accepted beacon >60s ago → idle (NOT connecting)', () => {
    // The exact SW-restart scenario: status persisted, user simply quiet.
    const v = computeStatus(base({ lastBeaconOkAt: 1_000, now: 1_000 + 61_000 }));
    expect(v.level).toBe('idle');
    expect(v.reasonCode).toBe('idle');
  });
});

// ─── buildStatusResponse — sanitized output ─────────────────────────

describe('buildStatusResponse — no secrets', () => {
  it('contains no key, sessionId, installId, proofToken, or org identifier', () => {
    const resp = buildStatusResponse({
      ...base(),
      lastStepUpResult: { at: 1234, success: true, decision: 'GO' },
      version: '0.2.1',
    });
    const json = JSON.stringify(resp);
    // The response schema is a closed set — assert every key.
    expect(Object.keys(resp).sort()).toEqual([
      'collectionEnabled', 'decisionHistory', 'lastStepUpAt', 'lastStepUpDecision',
      'lastStepUpSuccess', 'level', 'reasonCode', 'serverBackoffRemainingMs',
      'version',
    ]);
    // No field named like a secret.
    expect(json).not.toMatch(/ingestKey|sessionId|installId|proofToken|tenantId|orgName/i);
  });

  it('reflects last step-up result and version', () => {
    const resp = buildStatusResponse({
      ...base(),
      lastStepUpResult: { at: 555, success: false, decision: 'NO-GO' },
      version: '9.9.9',
    });
    expect(resp.lastStepUpAt).toBe(555);
    expect(resp.lastStepUpSuccess).toBe(false);
    expect(resp.lastStepUpDecision).toBe('NO-GO');
    expect(resp.version).toBe('9.9.9');
  });
});

// ─── Sender guards ──────────────────────────────────────────────────

const EXT_ID = 'vitest-test-extension';
const stepUpSender = (qs = 'sessionId=x&stepUpUrl=y') => ({
  id: EXT_ID,
  url: `chrome-extension://${EXT_ID}/src/step-up.html${qs ? `?${qs}` : ''}`,
});
const popupSender = { id: EXT_ID, url: `chrome-extension://${EXT_ID}/src/popup.html` };
const csSender = { id: EXT_ID, tab: { id: 7 }, url: 'https://example.com/page' };
const webSender = { id: 'some-other-ext', url: 'https://example.com/page', tab: { id: 7 } };

describe('sender guards (Phase 6b)', () => {
  beforeEach(() => {
    resetChromeMock();
    vi.restoreAllMocks();
    (globalThis as any).fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    __testResetStepUp();
    __testSetIngestKey(TEST_KEY);
  });

  it('stepup_result accepted from step-up.html WITH query string', async () => {
    const sendResponse = vi.fn();
    const keepAlive = onRuntimeMessage(
      { type: 'browserguard_stepup_result', decision: 'NO-GO', score: 10, confidence: 0, sessionId: 'gg_x', proofToken: null },
      stepUpSender(),
      sendResponse,
    );
    expect(keepAlive).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(sendResponse).toHaveBeenCalled();
  });

  it('stepup_result REJECTED from a content script', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const sendResponse = vi.fn();
    const r = onRuntimeMessage(
      { type: 'browserguard_stepup_result', decision: 'GO', score: 100, confidence: 1, sessionId: 'gg_x', proofToken: 'p' },
      csSender,
      sendResponse,
    );
    expect(r).toBe(false);
    expect(sendResponse).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
  });

  it('stepup_result REJECTED from a web page / foreign extension', () => {
    const r = onRuntimeMessage(
      { type: 'browserguard_stepup_result', decision: 'GO', score: 100, confidence: 1, sessionId: 'gg_x', proofToken: 'p' },
      webSender,
      vi.fn(),
    );
    expect(r).toBe(false);
  });

  it('stepup_result REJECTED from the popup page', () => {
    const r = onRuntimeMessage(
      { type: 'browserguard_stepup_result', decision: 'GO', score: 100, confidence: 1, sessionId: 'gg_x', proofToken: 'p' },
      popupSender,
      vi.fn(),
    );
    expect(r).toBe(false);
  });

  it('collection_query accepted from a content script, REJECTED from step-up page', async () => {
    const sendResponse = vi.fn();
    const ok = onRuntimeMessage({ type: 'browserguard_collection_query' }, csSender, sendResponse);
    expect(ok).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(sendResponse).toHaveBeenCalledWith({ collectionEnabled: true });

    const bad = onRuntimeMessage({ type: 'browserguard_collection_query' }, stepUpSender(), vi.fn());
    expect(bad).toBe(false);
  });

  it('behavior_snapshot REJECTED from step-up page (extension origin, no tab)', () => {
    const r = onRuntimeMessage(
      { type: 'browserguard_behavior_snapshot', snapshot: {} },
      stepUpSender(),
      vi.fn(),
    );
    expect(r).toBe(false);
  });

  it('status_query accepted ONLY from popup.html', async () => {
    const sendResponse = vi.fn();
    const ok = onRuntimeMessage({ type: 'browserguard_status_query' }, popupSender, sendResponse);
    expect(ok).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(sendResponse).toHaveBeenCalledWith(expect.objectContaining({ level: expect.any(String) }));

    expect(onRuntimeMessage({ type: 'browserguard_status_query' }, csSender, vi.fn())).toBe(false);
    expect(onRuntimeMessage({ type: 'browserguard_status_query' }, stepUpSender(), vi.fn())).toBe(false);
  });
});

// ─── Server verdict combination (point 5) ───────────────────────────

function makeResult(decision: string): StepUpResultMessage {
  return {
    type: 'browserguard_stepup_result',
    decision, score: 90, confidence: 0.9, engaged: true, reason: 'x',
    sessionId: 'gg_sess', completedCount: 3, plannedCount: 3, proofToken: 'pt',
  };
}

describe('verdict = iframe decision AND server acceptance', () => {
  beforeEach(() => {
    resetChromeMock();
    vi.restoreAllMocks();
    __testResetStepUp();
    __testSetIngestKey(TEST_KEY);
  });

  it('iframe GO + server 200 → success true', async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    const v = await handleStepUpResult(makeResult('GO'));
    expect(v.success).toBe(true);
    expect(getSessionData().browserguard_lastStepUpResult).toMatchObject({ success: true, decision: 'GO' });
  });

  it('iframe GO + server 403 → success FALSE (never "validée")', async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: false, status: 403, json: async () => ({ error: 'PROOF_INVALID' }),
    });
    const v = await handleStepUpResult(makeResult('GO'));
    expect(v.success).toBe(false);
    expect(v.code).toBe('PROOF_INVALID');
    expect(getSessionData().browserguard_lastStepUpResult.success).toBe(false);
  });

  it('iframe NO-GO + server 200 → success false (decision failed)', async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    const v = await handleStepUpResult(makeResult('NO-GO'));
    expect(v.success).toBe(false);
  });

  it('lastStepUpResult contains no sessionId, key, or proofToken', async () => {
    (globalThis as any).fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    await handleStepUpResult(makeResult('GO'));
    const saved = getSessionData().browserguard_lastStepUpResult;
    expect(Object.keys(saved).sort()).toEqual(['at', 'decision', 'success']);
  });
});

// ─── storage.session restore → idle, never connecting ───────────────

describe('restoreSessionStatus (SW restart simulation)', () => {
  beforeEach(() => {
    resetChromeMock();
    vi.restoreAllMocks();
    __testResetStepUp();
    __testSetIngestKey(TEST_KEY);
  });

  it('old lastBeaconOkAt + no failures → status idle, never connecting', async () => {
    const old = Date.now() - 120_000; // accepted 2 min ago, quiet since
    setSessionData('browserguard_lastBeaconOkAt', old);
    setSessionData('browserguard_lastStepUpResult', { at: old - 60_000, success: true, decision: 'GO' });

    await restoreSessionStatus();

    const snap = statusSnapshot();
    expect(snap.lastBeaconOkAt).toBe(old);
    const v = computeStatus({ ...snap });
    expect(v.level).toBe('idle'); // NOT 'connecting'
  });

  it('recent lastBeaconOkAt restored → active', async () => {
    setSessionData('browserguard_lastBeaconOkAt', Date.now() - 10_000);
    await restoreSessionStatus();
    expect(computeStatus({ ...statusSnapshot() }).level).toBe('active');
  });
});

// ─── stepUpRequiredPending reset matrix (point 6) ───────────────────

describe('stepUpRequiredPending lifecycle', () => {
  beforeEach(() => {
    resetChromeMock();
    vi.restoreAllMocks();
    (globalThis as any).fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    __testResetStepUp();
    __testSetIngestKey(TEST_KEY);
  });

  it('clearStepUpState (via handleStepUpResult) resets pending', async () => {
    __testSetStepUpRequiredPending(true);
    await handleStepUpResult(makeResult('GO'));
    expect(statusSnapshot().stepUpRequiredPending).toBe(false);
  });

  it('key loss (storage.onChanged managed) resets pending', async () => {
    __testSetStepUpRequiredPending(true);
    const { handleKeyStorageChange } = await import('../src/background');
    handleKeyStorageChange({ ingestKey: { oldValue: 'x' } }, 'managed');
    expect(statusSnapshot().stepUpRequiredPending).toBe(false);
  });

  it('suppressed popup (60s guard) resets pending', async () => {
    // Simulated via a beacon whose response requires step-up while the
    // reject cooldown is active — the guard branch must clear the flag.
    const { __testSetStepUpRejected } = await import('../src/background');
    __testSetStepUpRejected(Date.now() + 60_000);
    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ step_up_required: true, step_up_url: 'https://x/embed/' }),
    });
    const { sendBeacon, __testSetSnapshot } = await import('../src/background');
    __testSetSnapshot({
      keystrokeIntervals: [1], keystrokeHolds: [1], keystrokeCount: 1,
      mouseSpeeds: [1], mouseCurvatures: [1], mousePauseCount: 0, mouseEventCount: 1,
      scrollSpeeds: [1], scrollPauseCount: 0, scrollEventCount: 1,
      totalEvents: 3, timestamp: new Date().toISOString(),
    });
    await sendBeacon();
    expect(statusSnapshot().stepUpRequiredPending).toBe(false);
  });
});
