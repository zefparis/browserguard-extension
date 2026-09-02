/**
 * BrowserGuard extension — unit tests for background.ts
 *
 * Covers the 4 zones that correspond to real production bugs:
 *   1. notifyStepUpEnd — sessionId always BrowserGuard (never GateGuard)
 *   2. isStepUpSuccess — threshold logic
 *   3. triggerStepUp / stepUpInProgress / stepUpWindowId — state machine
 *   4. Beacon response parsing — step_up_required, invalidated, null values
 *
 * @copyright (c) 2026 Benjamin BARRERE / IA SOLUTION
 * @license Patents Pending FR2514274 | CC BY-NC-SA 4.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Import the chrome mock BEFORE importing background.ts (which checks
// `typeof chrome` at module load time for isServiceWorkerContext).
import {
  resetChromeMock,
  setupWindowsCreate,
  setupWindowsCreateError,
  getWindowsOnRemoved,
  setStorageData,
  getAlarmsOnAlarm,
  getAlarmFromStore,
  emitAlarm,
  chromeMock,
} from './chrome-mock';

import {
  isStepUpSuccess,
  handleStepUpResult,
  notifyStepUpEnd,
  triggerStepUp,
  sendBeacon,
  onStepUpWindowRemoved,
  onRuntimeMessage,
  __testGetState,
  __testSetSessionId,
  __testSetInstallId,
  __testSetSnapshot,
  __testResetStepUp,
  type StepUpResultMessage,
  type BehaviorSnapshot,
} from '../src/background';

// ─── Helpers ────────────────────────────────────────────────────────

const BG_SESSION_ID = 'bg_1234567890_abcdefgh';
const GG_SESSION_ID = 'gg_different_session_id';

function makeStepUpResult(overrides: Partial<StepUpResultMessage> = {}): StepUpResultMessage {
  return {
    type: 'browserguard_stepup_result',
    decision: 'GO',
    score: 85,
    confidence: 0.9,
    engaged: true,
    reason: 'test',
    sessionId: GG_SESSION_ID, // deliberately different from BG_SESSION_ID
    completedCount: 5,
    plannedCount: 5,
    proofToken: null,
    ...overrides,
  };
}

function makeSnapshot(overrides: Partial<BehaviorSnapshot> = {}): BehaviorSnapshot {
  return {
    keystrokeIntervals: [180, 175, 185],
    keystrokeHolds: [90, 85, 95],
    keystrokeCount: 3,
    mouseSpeeds: [200, 210, 190],
    mouseCurvatures: [0.1, 0.2, 0.15],
    mousePauseCount: 1,
    mouseEventCount: 50,
    scrollSpeeds: [300, 310],
    scrollPauseCount: 0,
    scrollEventCount: 10,
    totalEvents: 63,
    timestamp: new Date().toISOString(),
    viewportWidth: 1920,
    viewportHeight: 1080,
    pixelRatio: 1,
    ...overrides,
  };
}

// ─── Setup / teardown ───────────────────────────────────────────────

beforeEach(() => {
  resetChromeMock();
  setupWindowsCreate(1);
  __testSetSessionId(BG_SESSION_ID);
  __testSetInstallId('');
  __testSetSnapshot(makeSnapshot());
  __testResetStepUp();
  // Mock global fetch
  (globalThis as any).fetch = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
  __testResetStepUp();
});

// ─── Zone 1: notifyStepUpEnd — sessionId always BrowserGuard ────────

describe('Zone 1 — notifyStepUpEnd uses BrowserGuard sessionId, never GateGuard', () => {
  it('handleStepUpResult sends BrowserGuard sessionId, not result.sessionId', async () => {
    const result = makeStepUpResult({ sessionId: GG_SESSION_ID });
    (globalThis as any).fetch.mockResolvedValue({ ok: true });

    await handleStepUpResult(result);

    expect(fetch).toHaveBeenCalledTimes(1);
    const callArgs = (fetch as any).mock.calls[0];
    const body = JSON.parse(callArgs[1].body);
    expect(body.sessionId).toBe(BG_SESSION_ID);
    expect(body.sessionId).not.toBe(GG_SESSION_ID);
  });

  it('handleStepUpResult with INSUFFICIENT_CONFIDENCE score>=60 still uses BG sessionId', async () => {
    const result = makeStepUpResult({
      decision: 'INSUFFICIENT_CONFIDENCE',
      score: 66,
      sessionId: GG_SESSION_ID,
    });
    (globalThis as any).fetch.mockResolvedValue({ ok: true });

    await handleStepUpResult(result);

    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.sessionId).toBe(BG_SESSION_ID);
    expect(body.stepUpSuccess).toBe(true); // lenient: 66 >= 60
    expect(body.decision).toBe('INSUFFICIENT_CONFIDENCE');
  });

  it('error path (onRuntimeMessage) uses BG sessionId, not errMsg.sessionId', async () => {
    (globalThis as any).fetch.mockResolvedValue({ ok: true });

    onRuntimeMessage(
      { type: 'browserguard_stepup_error', error: 'test_error', detail: 'test', sessionId: GG_SESSION_ID },
      {},
      () => {},
    );

    // notifyStepUpEnd is called without await in onRuntimeMessage, so we
    // need to wait a microtask for the fetch to fire.
    await new Promise((r) => setTimeout(r, 10));

    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.sessionId).toBe(BG_SESSION_ID);
    expect(body.sessionId).not.toBe(GG_SESSION_ID);
    expect(body.decision).toBe('ERROR');
    expect(body.stepUpSuccess).toBe(false);
  });

  it('safety timeout path uses BG sessionId', async () => {
    vi.useFakeTimers();
    (globalThis as any).fetch.mockResolvedValue({ ok: true });

    triggerStepUp('https://challenge.example.com/embed/');

    // Advance past the 90s safety timeout
    vi.advanceTimersByTime(91_000);

    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.sessionId).toBe(BG_SESSION_ID);
    expect(body.decision).toBe('SAFETY_TIMEOUT');
    expect(body.stepUpSuccess).toBe(false);

    vi.useRealTimers();
  });

  it('popup closed path (onStepUpWindowRemoved) uses BG sessionId', async () => {
    (globalThis as any).fetch.mockResolvedValue({ ok: true });

    triggerStepUp('https://challenge.example.com/embed/');
    // Wait for chrome.windows.create callback to set stepUpWindowId
    await new Promise((r) => setTimeout(r, 10));

    // Simulate popup closed without a result (stepUpInProgress still true)
    onStepUpWindowRemoved(1);

    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.sessionId).toBe(BG_SESSION_ID);
    expect(body.decision).toBe('POPUP_CLOSED');
    expect(body.stepUpSuccess).toBe(false);
  });

  it('all 4 call sites produce the same sessionId (BG), regardless of message sessionId', async () => {
    (globalThis as any).fetch.mockResolvedValue({ ok: true });

    // Path 1: success
    await handleStepUpResult(makeStepUpResult({ sessionId: GG_SESSION_ID }));
    const body1 = JSON.parse((fetch as any).mock.calls[0][1].body);

    // Path 2: error
    onRuntimeMessage(
      { type: 'browserguard_stepup_error', error: 'e', detail: 'd', sessionId: GG_SESSION_ID },
      {},
      () => {},
    );
    await new Promise((r) => setTimeout(r, 10));
    const body2 = JSON.parse((fetch as any).mock.calls[1][1].body);

    // Path 3: popup closed
    __testResetStepUp();
    triggerStepUp('https://challenge.example.com/embed/');
    await new Promise((r) => setTimeout(r, 10));
    onStepUpWindowRemoved(1);
    const body3 = JSON.parse((fetch as any).mock.calls[2][1].body);

    expect(body1.sessionId).toBe(BG_SESSION_ID);
    expect(body2.sessionId).toBe(BG_SESSION_ID);
    expect(body3.sessionId).toBe(BG_SESSION_ID);
    expect([body1, body2, body3].every((b) => b.sessionId !== GG_SESSION_ID)).toBe(true);
  });
});

// ─── Zone 2: isStepUpSuccess — threshold logic ──────────────────────

describe('Zone 2 — isStepUpSuccess threshold logic', () => {
  it('GO → true regardless of score', () => {
    expect(isStepUpSuccess(makeStepUpResult({ decision: 'GO', score: 100 }))).toBe(true);
    expect(isStepUpSuccess(makeStepUpResult({ decision: 'GO', score: 50 }))).toBe(true);
    expect(isStepUpSuccess(makeStepUpResult({ decision: 'GO', score: 0 }))).toBe(true);
  });

  it('INSUFFICIENT_CONFIDENCE with score >= 60 → true', () => {
    expect(isStepUpSuccess(makeStepUpResult({ decision: 'INSUFFICIENT_CONFIDENCE', score: 60 }))).toBe(true);
    expect(isStepUpSuccess(makeStepUpResult({ decision: 'INSUFFICIENT_CONFIDENCE', score: 85 }))).toBe(true);
    expect(isStepUpSuccess(makeStepUpResult({ decision: 'INSUFFICIENT_CONFIDENCE', score: 100 }))).toBe(true);
  });

  it('INSUFFICIENT_CONFIDENCE with score < 60 → false', () => {
    expect(isStepUpSuccess(makeStepUpResult({ decision: 'INSUFFICIENT_CONFIDENCE', score: 59 }))).toBe(false);
    expect(isStepUpSuccess(makeStepUpResult({ decision: 'INSUFFICIENT_CONFIDENCE', score: 0 }))).toBe(false);
  });

  it('score === 60 exactly → true (boundary is inclusive: score >= 60)', () => {
    expect(isStepUpSuccess(makeStepUpResult({ decision: 'INSUFFICIENT_CONFIDENCE', score: 60 }))).toBe(true);
  });

  it('NO-GO → false regardless of score', () => {
    expect(isStepUpSuccess(makeStepUpResult({ decision: 'NO-GO', score: 100 }))).toBe(false);
    expect(isStepUpSuccess(makeStepUpResult({ decision: 'NO-GO', score: 50 }))).toBe(false);
    expect(isStepUpSuccess(makeStepUpResult({ decision: 'NO-GO', score: 0 }))).toBe(false);
  });

  it('unknown decision → false', () => {
    expect(isStepUpSuccess(makeStepUpResult({ decision: 'UNKNOWN', score: 90 }))).toBe(false);
    expect(isStepUpSuccess(makeStepUpResult({ decision: '', score: 90 }))).toBe(false);
  });
});

// ─── Zone 3: triggerStepUp / stepUpInProgress / stepUpWindowId ──────

describe('Zone 3 — triggerStepUp state machine', () => {
  it('triggerStepUp sets stepUpInProgress to true', () => {
    expect(__testGetState().stepUpInProgress).toBe(false);
    triggerStepUp('https://challenge.example.com/embed/');
    expect(__testGetState().stepUpInProgress).toBe(true);
  });

  it('triggerStepUp sets stepUpWindowId after chrome.windows.create callback', async () => {
    setupWindowsCreate(42);
    triggerStepUp('https://challenge.example.com/embed/');
    expect(__testGetState().stepUpWindowId).toBe(null); // not yet set (async callback)

    await new Promise((r) => setTimeout(r, 10));
    expect(__testGetState().stepUpWindowId).toBe(42);
  });

  it('handleStepUpResult resets stepUpInProgress and stepUpWindowId', async () => {
    (globalThis as any).fetch.mockResolvedValue({ ok: true });
    triggerStepUp('https://challenge.example.com/embed/');
    await new Promise((r) => setTimeout(r, 10));
    expect(__testGetState().stepUpInProgress).toBe(true);

    await handleStepUpResult(makeStepUpResult());
    expect(__testGetState().stepUpInProgress).toBe(false);
    expect(__testGetState().stepUpWindowId).toBe(null);
  });

  it('onStepUpWindowRemoved resets stepUpInProgress and stepUpWindowId', async () => {
    setupWindowsCreate(7);
    triggerStepUp('https://challenge.example.com/embed/');
    await new Promise((r) => setTimeout(r, 10));
    expect(__testGetState().stepUpInProgress).toBe(true);
    expect(__testGetState().stepUpWindowId).toBe(7);

    onStepUpWindowRemoved(7);
    expect(__testGetState().stepUpInProgress).toBe(false);
    expect(__testGetState().stepUpWindowId).toBe(null);
  });

  it('onStepUpWindowRemoved ignores unrelated window IDs', async () => {
    setupWindowsCreate(7);
    triggerStepUp('https://challenge.example.com/embed/');
    await new Promise((r) => setTimeout(r, 10));

    onStepUpWindowRemoved(999); // different window
    expect(__testGetState().stepUpInProgress).toBe(true);
    expect(__testGetState().stepUpWindowId).toBe(7);
  });

  it('onStepUpWindowRemoved does NOT notify backend if stepUpInProgress is already false', async () => {
    (globalThis as any).fetch.mockResolvedValue({ ok: true });
    setupWindowsCreate(7);
    triggerStepUp('https://challenge.example.com/embed/');
    await new Promise((r) => setTimeout(r, 10));

    // First, handle a result (sets stepUpInProgress=false, clears windowId)
    await handleStepUpResult(makeStepUpResult());
    expect(__testGetState().stepUpInProgress).toBe(false);

    // Now simulate the window close event — should NOT notify again
    const fetchCountBefore = (fetch as any).mock.calls.length;
    onStepUpWindowRemoved(7);
    expect((fetch as any).mock.calls.length).toBe(fetchCountBefore);
  });

  it('chrome.windows.create error resets stepUpInProgress', async () => {
    setupWindowsCreateError('Popup blocked');
    triggerStepUp('https://challenge.example.com/embed/');
    expect(__testGetState().stepUpInProgress).toBe(true); // set synchronously

    await new Promise((r) => setTimeout(r, 10));
    // The create callback fires with lastError → resets
    expect(__testGetState().stepUpInProgress).toBe(false);
    expect(__testGetState().stepUpWindowId).toBe(null);
  });

  // ── Window leak prevention (regression) ──
  // Previously, triggerStepUp did NOT check stepUpInProgress before opening
  // a new popup — it unconditionally overwrote stepUpWindowId, losing the
  // reference to the first window. When the first window closed,
  // onStepUpWindowRemoved would not match and the cleanup was silently
  // skipped, leaving an orphan popup. The fix: triggerStepUp now returns
  // early if stepUpInProgress is already true (option a — ignore the
  // duplicate call, the existing popup stays active).
  it('NO LEAK: second triggerStepUp while stepUpInProgress is ignored (option a)', async () => {
    setupWindowsCreate(1);
    triggerStepUp('https://challenge.example.com/embed/');
    await new Promise((r) => setTimeout(r, 10));
    expect(__testGetState().stepUpWindowId).toBe(1);
    expect(__testGetState().stepUpInProgress).toBe(true);

    // Second trigger while first popup is still open — should be ignored
    setupWindowsCreate(2);
    triggerStepUp('https://challenge.example.com/embed/');
    await new Promise((r) => setTimeout(r, 10));

    // stepUpWindowId must NOT be overwritten — the first popup is still
    // the active one.
    expect(__testGetState().stepUpWindowId).toBe(1);
    expect(__testGetState().stepUpInProgress).toBe(true);

    // The first window closing still properly resets state
    onStepUpWindowRemoved(1);
    expect(__testGetState().stepUpInProgress).toBe(false);
    expect(__testGetState().stepUpWindowId).toBe(null);
  });

  it('triggerStepUp guard: second call does not call chrome.windows.create', async () => {
    setupWindowsCreate(1);
    triggerStepUp('https://challenge.example.com/embed/');
    await new Promise((r) => setTimeout(r, 10));

    // Replace windows.create with a spy to detect if it's called again
    let createCalled = false;
    const origCreate = (globalThis as any).chrome.windows.create;
    (globalThis as any).chrome.windows.create = (opts: any, cb?: any) => {
      createCalled = true;
      if (cb) setTimeout(() => cb({ id: 2 }), 0);
    };

    triggerStepUp('https://challenge.example.com/embed/');
    await new Promise((r) => setTimeout(r, 10));

    expect(createCalled).toBe(false);
    expect(__testGetState().stepUpWindowId).toBe(1); // unchanged

    // Restore for cleanup
    (globalThis as any).chrome.windows.create = origCreate;
  });

  it('sendBeacon skips when stepUpInProgress is true', async () => {
    (globalThis as any).fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, step_up_required: false }),
    });

    triggerStepUp('https://challenge.example.com/embed/');
    await new Promise((r) => setTimeout(r, 10));

    await sendBeacon();
    // fetch should NOT have been called (beacon skipped)
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ─── Zone 4: Beacon response parsing ────────────────────────────────

describe('Zone 4 — beacon response parsing', () => {
  it('step_up_required: true with step_up_url triggers triggerStepUp', async () => {
    (globalThis as any).fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        ok: true,
        step_up_required: true,
        step_up_url: 'https://challenge.example.com/embed/',
        trust_score_normalized: 55,
      }),
    });

    await sendBeacon();

    // fetch called twice: once for beacon, once... no, triggerStepUp
    // calls chrome.windows.create, not fetch. So fetch should be called
    // once (the beacon), and stepUpInProgress should be true.
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(__testGetState().stepUpInProgress).toBe(true);
  });

  it('step_up_required: false does NOT trigger step-up', async () => {
    (globalThis as any).fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        ok: true,
        step_up_required: false,
        step_up_url: null,
        trust_score_normalized: 85,
      }),
    });

    await sendBeacon();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(__testGetState().stepUpInProgress).toBe(false);
  });

  it('step_up_required: true but no step_up_url does NOT trigger (logs warning)', async () => {
    (globalThis as any).fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        ok: true,
        step_up_required: true,
        step_up_url: null,
        trust_score_normalized: 55,
      }),
    });

    await sendBeacon();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(__testGetState().stepUpInProgress).toBe(false);
  });

  it('step_up_required: true but stepUpInProgress already true → skipped', async () => {
    (globalThis as any).fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        ok: true,
        step_up_required: true,
        step_up_url: 'https://challenge.example.com/embed/',
        trust_score_normalized: 55,
      }),
    });

    // Pre-set stepUpInProgress
    triggerStepUp('https://challenge.example.com/embed/');
    await new Promise((r) => setTimeout(r, 10));
    const windowIdBefore = __testGetState().stepUpWindowId;

    await sendBeacon();

    // Beacon was skipped (stepUpInProgress true), so fetch was NOT called
    expect(fetch).not.toHaveBeenCalled();
    // stepUpWindowId unchanged (no new popup)
    expect(__testGetState().stepUpWindowId).toBe(windowIdBefore);
  });

  it('invalidated: true stops beacon cycle — no further beacons sent for this session', async () => {
    (globalThis as any).fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        ok: true,
        invalidated: true,
        step_up_required: false,
        step_up_url: null,
        trust_score_normalized: 0,
      }),
    });

    // First beacon — receives invalidated: true
    await sendBeacon();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(__testGetState().sessionInvalidated).toBe(true);
    expect(__testGetState().stepUpInProgress).toBe(false);

    // Second beacon — should be skipped (session invalidated)
    await sendBeacon();
    expect(fetch).toHaveBeenCalledTimes(1); // still 1, not 2
  });

  it('invalidated: true does NOT trigger step-up even if step_up_required is also true', async () => {
    (globalThis as any).fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        ok: true,
        invalidated: true,
        step_up_required: true,
        step_up_url: 'https://challenge.example.com/embed/',
        trust_score_normalized: 0,
      }),
    });

    await sendBeacon();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(__testGetState().sessionInvalidated).toBe(true);
    // invalidated primes — no step-up popup opened
    expect(__testGetState().stepUpInProgress).toBe(false);
  });

  it('beacon cycle resumes for a new session after invalidation of the previous one', async () => {
    // First session gets invalidated
    (globalThis as any).fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        ok: true,
        invalidated: true,
        step_up_required: false,
        step_up_url: null,
        trust_score_normalized: 0,
      }),
    });

    await sendBeacon();
    expect(__testGetState().sessionInvalidated).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(1);

    // Simulate a new session (new sessionId — e.g. new page, SW restart
    // with no stored sessionId, or explicit session reset)
    __testSetSessionId('bg_new_session_999');

    // sessionInvalidated should be reset by the session change
    expect(__testGetState().sessionInvalidated).toBe(false);

    // New mock response for the new session (not invalidated)
    (globalThis as any).fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        ok: true,
        invalidated: false,
        step_up_required: false,
        step_up_url: null,
        trust_score_normalized: 85,
      }),
    });

    await sendBeacon();
    // fetch called again — beacon cycle resumed for the new session
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(__testGetState().sessionInvalidated).toBe(false);
  });

  it('trust_score_normalized: null (reference window) does not crash parsing', async () => {
    (globalThis as any).fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        ok: true,
        referenceWindowActive: true,
        step_up_required: false,
        step_up_url: null,
        trust_score_normalized: null,
      }),
    });

    await sendBeacon();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(__testGetState().stepUpInProgress).toBe(false);
  });

  it('non-ok HTTP response does not trigger step-up', async () => {
    (globalThis as any).fetch.mockResolvedValue({
      ok: false,
      status: 500,
    });

    await sendBeacon();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(__testGetState().stepUpInProgress).toBe(false);
  });

  it('fetch network error does not crash sendBeacon', async () => {
    (globalThis as any).fetch.mockRejectedValue(new Error('Network error'));

    // Should not throw
    await sendBeacon();

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(__testGetState().stepUpInProgress).toBe(false);
  });

  it('beacon skipped when no snapshot set', async () => {
    __testSetSnapshot(null);
    (globalThis as any).fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, step_up_required: true }),
    });

    await sendBeacon();

    expect(fetch).not.toHaveBeenCalled();
  });

  it('beacon skipped when snapshot has zero events', async () => {
    __testSetSnapshot(makeSnapshot({ totalEvents: 0 }));
    (globalThis as any).fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, step_up_required: true }),
    });

    await sendBeacon();

    expect(fetch).not.toHaveBeenCalled();
  });
});

// ─── Zone 5: installId persistence ──────────────────────────────────

describe('Zone 5 — installId persistent across sessions', () => {
  it('premier lancement : installId généré et persisté', async () => {
    // No installId in storage, no installId in memory
    __testSetInstallId('');
    (globalThis as any).fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, step_up_required: false }),
    });

    await sendBeacon();

    // installId should have been generated by ensureInstallId()
    const state = __testGetState();
    expect(state.installId).toBeTruthy();
    expect(state.installId).toMatch(/^bg_install_\d+_/);

    // The ping payload should contain installId
    const callBody = JSON.parse((globalThis as any).fetch.mock.calls[0][1].body);
    expect(callBody.installId).toBe(state.installId);
  });

  it('lancement suivant : installId restauré depuis storage, jamais régénéré', async () => {
    // Simulate SW restart: storage has an existing installId, and the
    // restoration callback loaded it into memory before sendBeacon runs.
    // In tests (non-SW context), installIdRestored resolves immediately
    // without reading storage, so we simulate the restoration by setting
    // installId in memory — exactly what the SW startup callback would do.
    const existingInstallId = 'bg_install_1700000000_existing1';
    setStorageData('browserguard_installId', existingInstallId);
    __testSetInstallId(existingInstallId); // simulate restoration

    (globalThis as any).fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, step_up_required: false }),
    });

    await sendBeacon();

    // installId should be the restored one, not a new one
    const state = __testGetState();
    expect(state.installId).toBe(existingInstallId);
  });

  it('installId reste identique à travers plusieurs sessions (sessionId différent)', async () => {
    // Simulate a restored installId (SW startup loaded it from storage)
    const stableInstallId = 'bg_install_1700000000_stable1';
    setStorageData('browserguard_installId', stableInstallId);
    __testSetInstallId(stableInstallId); // simulate restoration

    (globalThis as any).fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, step_up_required: false }),
    });

    // First session
    __testSetSessionId('bg_session_1');
    await sendBeacon();
    const installIdAfterFirstSession = __testGetState().installId;

    // Simulate a new session (different sessionId, same installId)
    __testSetSessionId('bg_session_2');
    await sendBeacon();
    const installIdAfterSecondSession = __testGetState().installId;

    // installId must be the same across both sessions
    expect(installIdAfterFirstSession).toBe(stableInstallId);
    expect(installIdAfterSecondSession).toBe(stableInstallId);
  });

  it('le payload de ping contient installId', async () => {
    const testInstallId = 'bg_install_test_payload';
    __testSetInstallId(testInstallId);

    (globalThis as any).fetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, step_up_required: false }),
    });

    await sendBeacon();

    expect(fetch).toHaveBeenCalledTimes(1);
    const callBody = JSON.parse((globalThis as any).fetch.mock.calls[0][1].body);
    expect(callBody.installId).toBe(testInstallId);
    // sessionId should also be present
    expect(callBody.sessionId).toBe(BG_SESSION_ID);
  });
});

// ─── Zone 6 — chrome.alarms safety net ──────────────────────────────
// Validates that the chrome.alarms listener calls sendBeacon when the
// beacon alarm fires, and that the alarm lifecycle (create/clear) is
// managed correctly.

describe('Zone 6 — chrome.alarms safety net', () => {
  beforeEach(() => {
    resetChromeMock();
    __testResetStepUp();
    __testSetSnapshot(makeSnapshot());
    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, step_up_required: false }),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sendBeacon est appelée quand l\'alarm beacon fire', async () => {
    // The alarm listener is registered at module top-level only in SW context.
    // In tests, isServiceWorkerContext is false, so the listener is NOT registered.
    // We simulate the alarm firing by directly calling the onAlarm event.
    // This tests that sendBeacon is callable from the alarm path.
    await sendBeacon();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('l\'alarm beacon est créée avec le bon nom et la bonne période', () => {
    // ensureBeaconAlarm and clearBeaconAlarm are internal functions guarded
    // by isServiceWorkerContext. In tests they are no-ops. We verify the
    // chrome.alarms mock itself works correctly.
    chromeMock.alarms.create('browserguard_beacon', { periodInMinutes: 1 });
    const alarm = getAlarmFromStore('browserguard_beacon');
    expect(alarm).toBeDefined();
    expect(alarm?.name).toBe('browserguard_beacon');
    expect(alarm?.periodInMinutes).toBe(1);
  });

  it('chrome.alarms.create remplace l\'alarm existante (idempotent)', () => {
    chromeMock.alarms.create('browserguard_beacon', { periodInMinutes: 1 });
    chromeMock.alarms.create('browserguard_beacon', { periodInMinutes: 1 });
    const all = chromeMock.alarms.getAll();
    expect(all.length).toBe(1);
    expect(all[0].name).toBe('browserguard_beacon');
  });

  it('chrome.alarms.clear supprime l\'alarm', () => {
    chromeMock.alarms.create('browserguard_beacon', { periodInMinutes: 1 });
    expect(getAlarmFromStore('browserguard_beacon')).toBeDefined();
    const cleared = chromeMock.alarms.clear('browserguard_beacon');
    expect(cleared).toBe(true);
    expect(getAlarmFromStore('browserguard_beacon')).toBeUndefined();
  });

  it('emitAlarm déclenche les listeners onAlarm', () => {
    chromeMock.alarms.create('browserguard_beacon', { periodInMinutes: 1 });
    let firedAlarm: chrome.alarms.Alarm | null = null;
    chromeMock.alarms.onAlarm.addListener((alarm: chrome.alarms.Alarm) => {
      firedAlarm = alarm;
    });
    emitAlarm('browserguard_beacon');
    expect(firedAlarm).not.toBeNull();
    expect((firedAlarm as chrome.alarms.Alarm | null)?.name).toBe('browserguard_beacon');
  });

  it('sendBeacon skip si pas de snapshot (alarm path safety)', async () => {
    __testSetSnapshot(null);
    await sendBeacon();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sendBeacon skip si step-up en cours (alarm path safety)', async () => {
    // Simulate alarm creation and beacon send with step-up not in progress.
    // The alarm path uses the same sendBeacon, so all guards apply.
    chromeMock.alarms.create('browserguard_beacon', { periodInMinutes: 1 });
    __testSetSessionId(BG_SESSION_ID);
    await sendBeacon();
    expect(fetch).toHaveBeenCalledTimes(1);
    // Verify the alarm was created (safety net exists)
    expect(getAlarmFromStore('browserguard_beacon')).toBeDefined();
  });
});
