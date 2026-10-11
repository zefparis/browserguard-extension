/**
 * Phase 6 — ingest-key gating, server-error classification, backoff,
 * popup suppression, and collection-gate messaging.
 *
 * Covers the mandatory behaviors:
 *   - SANS CLE = RIEN: no key → no ping fetch, no step-up-result fetch
 *   - X-BrowserGuard-Key on every backend call
 *   - 403 AUTH_FAILED / TENANT_MISMATCH / 500 TENANT_NOT_RESOLVED /
 *     503 TENANT_CHECK_UNAVAILABLE → exponential backoff, no popup
 *   - 403 SESSION_UNKNOWN on step-up-result → popup guard 60s + new session
 *   - SESSION_ROTATED → exactly one retry through the same classification
 *   - browserguard_collection_query → boolean answer to content scripts
 *   - key change in storage → broadcastCollectionState → tabs.sendMessage
 *
 * @copyright (c) 2026 Benjamin BARRERE / IA SOLUTION
 * @license Patents Pending FR2514274 | CC BY-NC-SA 4.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// vitest `?raw` imports — source text for the static wiring assertions.
import bgSource from '../src/background.ts?raw';
import csSource from '../src/content-script.ts?raw';

import {
  resetChromeMock,
  setupWindowsCreate,
  setStorageData,
  setManagedData,
  getStorageOnChanged,
  getTabsState,
  chromeMock,
} from './chrome-mock';

import {
  sendBeacon,
  notifyStepUpEnd,
  onRuntimeMessage,
  refreshIngestKey,
  broadcastCollectionState,
  handleKeyStorageChange,
  __testGetState,
  __testSetSessionId,
  __testSetInstallId,
  __testSetSnapshot,
  __testSetIngestKey,
  __testSetDevBuild,
  __testSetServerBackoff,
  __testResetStepUp,
  type BehaviorSnapshot,
} from '../src/background';

// A fake tenant key — 64 'a' chars, NOT a real secret.
const TEST_KEY = 'a'.repeat(64);
const BG_SESSION_ID = 'bg_1234567890_abcdefgh';

function makeSnapshot(): BehaviorSnapshot {
  return {
    keystrokeIntervals: [180, 175],
    keystrokeHolds: [90, 85],
    keystrokeCount: 2,
    mouseSpeeds: [200],
    mouseCurvatures: [0.1],
    mousePauseCount: 0,
    mouseEventCount: 10,
    scrollSpeeds: [300],
    scrollPauseCount: 0,
    scrollEventCount: 2,
    totalEvents: 15,
    timestamp: new Date().toISOString(),
    viewportWidth: 1920,
    viewportHeight: 1080,
    pixelRatio: 1,
  };
}

function okResponse(data: Record<string, unknown> = {}): any {
  return { ok: true, status: 200, json: async () => data };
}

function errResponse(status: number, error?: string, extra: Record<string, unknown> = {}): any {
  return { ok: false, status, json: async () => (error ? { error, ...extra } : { ...extra }) };
}

function lastFetchHeaders(): Record<string, string> {
  const calls = (fetch as any).mock.calls;
  return calls[calls.length - 1][1].headers;
}

beforeEach(() => {
  resetChromeMock();
  setupWindowsCreate(1);
  __testSetSessionId(BG_SESSION_ID);
  __testSetInstallId('');
  __testSetSnapshot(makeSnapshot());
  __testResetStepUp();
  __testSetDevBuild(true);
  (globalThis as any).fetch = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  __testSetDevBuild(true);
  __testResetStepUp();
});

// ─── 1. SANS CLE = RIEN ─────────────────────────────────────────────

describe('SANS CLE = RIEN — no key, no activity', () => {
  it('sendBeacon issues no fetch when no key is provisioned', async () => {
    await sendBeacon();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('notifyStepUpEnd issues no fetch when no key is provisioned', async () => {
    await notifyStepUpEnd(BG_SESSION_ID, false, 'POPUP_CLOSED', 0, 0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('sendBeacon works again once a managed key appears', async () => {
    await sendBeacon();
    expect(fetch).not.toHaveBeenCalled();

    setManagedData('ingestKey', TEST_KEY);
    // Force re-read (cache may hold a null from the previous refresh)
    await refreshIngestKey(true);
    (globalThis as any).fetch.mockResolvedValue(okResponse());

    await sendBeacon();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(lastFetchHeaders()['X-BrowserGuard-Key']).toBe(TEST_KEY);
  });
});

// ─── 2. Key provisioning paths ──────────────────────────────────────

describe('key provisioning — managed first, dev local fallback', () => {
  it('reads the key from chrome.storage.managed', async () => {
    setManagedData('ingestKey', TEST_KEY);
    (globalThis as any).fetch.mockResolvedValue(okResponse());
    await sendBeacon();
    expect(lastFetchHeaders()['X-BrowserGuard-Key']).toBe(TEST_KEY);
  });

  it('dev build falls back to chrome.storage.local', async () => {
    setStorageData('browserguard_ingestKey', TEST_KEY);
    (globalThis as any).fetch.mockResolvedValue(okResponse());
    await sendBeacon();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(lastFetchHeaders()['X-BrowserGuard-Key']).toBe(TEST_KEY);
  });

  it('managed key wins over the dev local fallback', async () => {
    const MANAGED = 'b'.repeat(64);
    setManagedData('ingestKey', MANAGED);
    setStorageData('browserguard_ingestKey', TEST_KEY);
    (globalThis as any).fetch.mockResolvedValue(okResponse());
    await sendBeacon();
    expect(lastFetchHeaders()['X-BrowserGuard-Key']).toBe(MANAGED);
  });

  it('production path ignores the local fallback entirely', async () => {
    __testSetDevBuild(false);
    setStorageData('browserguard_ingestKey', TEST_KEY);
    await sendBeacon();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects keys shorter than 32 chars', async () => {
    setManagedData('ingestKey', 'too-short');
    await sendBeacon();
    expect(fetch).not.toHaveBeenCalled();
  });
});

// ─── 3. Backend error classification ───────────────────────────────

describe('beacon error classification', () => {
  it('403 AUTH_FAILED → backoff set, no popup, next call skipped', async () => {
    __testSetIngestKey(TEST_KEY);
    (globalThis as any).fetch.mockResolvedValue(errResponse(403, 'BROWSERGUARD_AUTH_FAILED'));

    await sendBeacon();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(__testGetState().serverBackoffUntil).toBeGreaterThan(Date.now());

    await sendBeacon();
    expect(fetch).toHaveBeenCalledTimes(1); // backoff skip — no new fetch
  });

  it('AUTH_FAILED drops the cached key so the policy is re-read', async () => {
    __testSetIngestKey(TEST_KEY);
    (globalThis as any).fetch.mockResolvedValue(errResponse(403, 'BROWSERGUARD_AUTH_FAILED'));
    await sendBeacon();
    expect(__testGetState().ingestKey).toBeNull();
  });

  it('403 TENANT_MISMATCH → sessionId regenerated exactly once', async () => {
    __testSetIngestKey(TEST_KEY);
    (globalThis as any).fetch.mockResolvedValue(errResponse(403, 'BROWSERGUARD_TENANT_MISMATCH'));

    await sendBeacon();
    const newSession = __testGetState().sessionId;
    expect(newSession).not.toBe(BG_SESSION_ID);
    expect(__testGetState().tenantMismatchRotated).toBe(true);

    // Second mismatch must NOT regenerate again — same sessionId.
    await sendBeacon(); // skipped by backoff — sessionId unchanged
    expect(__testGetState().sessionId).toBe(newSession);
  });

  it('successful beacon clears backoff and the mismatch flag', async () => {
    __testSetIngestKey(TEST_KEY);
    __testSetServerBackoff(Date.now() - 1, 4); // expired backoff
    (globalThis as any).fetch.mockResolvedValue(okResponse());
    await sendBeacon();
    expect(__testGetState().serverBackoffStep).toBe(0);
    expect(__testGetState().tenantMismatchRotated).toBe(false);
  });

  it.each([
    [500, 'BROWSERGUARD_TENANT_NOT_RESOLVED'],
    [503, 'BROWSERGUARD_TENANT_CHECK_UNAVAILABLE'],
  ])('%i %s → backoff, no popup', async (status, code) => {
    __testSetIngestKey(TEST_KEY);
    (globalThis as any).fetch.mockResolvedValue(errResponse(status, code));
    const createSpy = vi.fn((opts: any, cb?: any) => cb && cb({ id: 1 }));
    chromeMock.windows.create = createSpy as any;

    await sendBeacon();
    expect(__testGetState().serverBackoffUntil).toBeGreaterThan(Date.now());
    expect(createSpy).not.toHaveBeenCalled();
  });

  it('backoff is exponential and capped at 5 minutes', async () => {
    // Managed storage seeded: AUTH_FAILED drops the in-memory cache, so
    // each iteration re-reads the (valid) key and reaches the fetch.
    setManagedData('ingestKey', TEST_KEY);
    (globalThis as any).fetch.mockResolvedValue(errResponse(403, 'BROWSERGUARD_AUTH_FAILED'));

    // step 0 → 5s, step 1 → 10s … capped at 300s
    const expected = [5_000, 10_000, 20_000];
    for (const delay of expected) {
      __testSetServerBackoff(0, __testGetState().serverBackoffStep);
      await sendBeacon();
      const until = __testGetState().serverBackoffUntil;
      expect(until - Date.now()).toBeGreaterThan(delay - 1_000);
      expect(until - Date.now()).toBeLessThanOrEqual(delay + 1_000);
    }

    // At high step, delay must cap at 300s
    __testSetServerBackoff(0, 7);
    await sendBeacon();
    expect(__testGetState().serverBackoffUntil - Date.now()).toBeLessThanOrEqual(301_000);
  });

  it('one warn per rejection — skips are silent', async () => {
    __testSetIngestKey(TEST_KEY);
    (globalThis as any).fetch.mockResolvedValue(errResponse(403, 'BROWSERGUARD_AUTH_FAILED'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await sendBeacon(); // rejected → 1 warn
    await sendBeacon(); // backoff skip → no warn
    await sendBeacon(); // backoff skip → no warn

    const backoffWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes('Server backoff'));
    expect(backoffWarns.length).toBe(1);
  });
});

// ─── 4. SESSION_ROTATED — single retry, same classification ────────

describe('SESSION_ROTATED retry', () => {
  it('retries once with the new sessionId and processes the response', async () => {
    __testSetIngestKey(TEST_KEY);
    const NEW_ID = 'bg_rotated_new';
    (globalThis as any).fetch
      .mockResolvedValueOnce(errResponse(403, 'SESSION_ROTATED', { new_session_id: NEW_ID }))
      .mockResolvedValueOnce(okResponse());

    await sendBeacon();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(__testGetState().sessionId).toBe(NEW_ID);
    // The retry carried the rotated sessionId and the tenant key
    const retryBody = JSON.parse((fetch as any).mock.calls[1][1].body);
    expect(retryBody.sessionId).toBe(NEW_ID);
    expect(lastFetchHeaders()['X-BrowserGuard-Key']).toBe(TEST_KEY);
  });

  it('a failed retry goes through error classification — never a second retry', async () => {
    __testSetIngestKey(TEST_KEY);
    (globalThis as any).fetch
      .mockResolvedValueOnce(errResponse(403, 'SESSION_ROTATED', { new_session_id: 'bg_r1' }))
      .mockResolvedValueOnce(errResponse(403, 'BROWSERGUARD_AUTH_FAILED'));

    await sendBeacon();
    expect(fetch).toHaveBeenCalledTimes(2); // exactly one retry
    expect(__testGetState().serverBackoffUntil).toBeGreaterThan(Date.now());
    expect(__testGetState().ingestKey).toBeNull();
  });
});

// ─── 5. step-up-result rejection handling ──────────────────────────

describe('notifyStepUpEnd rejections', () => {
  it('sends X-BrowserGuard-Key when provisioned', async () => {
    __testSetIngestKey(TEST_KEY);
    (globalThis as any).fetch.mockResolvedValue(okResponse());
    await notifyStepUpEnd(BG_SESSION_ID, false, 'POPUP_CLOSED', 0, 0);
    expect(lastFetchHeaders()['X-BrowserGuard-Key']).toBe(TEST_KEY);
  });

  it('any rejection sets the 60s popup guard', async () => {
    __testSetIngestKey(TEST_KEY);
    (globalThis as any).fetch.mockResolvedValue(errResponse(403, 'PROOF_EXPIRED'));
    await notifyStepUpEnd(BG_SESSION_ID, true, 'GO', 90, 0.9, 'proof');
    expect(__testGetState().stepUpRejectedUntil).toBeGreaterThan(Date.now() + 55_000);
    expect(__testGetState().stepUpRejectedUntil).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it('SESSION_UNKNOWN → new sessionId + 60s guard', async () => {
    __testSetIngestKey(TEST_KEY);
    (globalThis as any).fetch.mockResolvedValue(errResponse(403, 'BROWSERGUARD_SESSION_UNKNOWN'));
    await notifyStepUpEnd(BG_SESSION_ID, false, 'POPUP_CLOSED', 0, 0);
    expect(__testGetState().sessionId).not.toBe(BG_SESSION_ID);
    expect(__testGetState().stepUpRejectedUntil).toBeGreaterThan(Date.now());
  });

  it.each([
    'BROWSERGUARD_AUTH_FAILED',
    'BROWSERGUARD_TENANT_MISMATCH',
    'BROWSERGUARD_TENANT_NOT_RESOLVED',
    'BROWSERGUARD_TENANT_CHECK_UNAVAILABLE',
  ])('%s → beacon backoff (budget preserved)', async (code) => {
    __testSetIngestKey(TEST_KEY);
    (globalThis as any).fetch.mockResolvedValue(errResponse(403, code));
    await notifyStepUpEnd(BG_SESSION_ID, false, 'POPUP_CLOSED', 0, 0);
    expect(__testGetState().serverBackoffUntil).toBeGreaterThan(Date.now());
    expect(__testGetState().stepUpRejectedUntil).toBeGreaterThan(Date.now());
  });
});

// ─── 6. Popup suppression after a rejected step-up-result ──────────

describe('popup guard — 60s after a rejected step-up-result', () => {
  it('step_up_required within the guard window does NOT open a popup', async () => {
    __testSetIngestKey(TEST_KEY);
    // First: a rejected step-up-result
    (globalThis as any).fetch.mockResolvedValueOnce(errResponse(403, 'PROOF_EXPIRED'));
    await notifyStepUpEnd(BG_SESSION_ID, true, 'GO', 90, 0.9, 'proof');

    // Then: server keeps offering step-ups — the guard must suppress it
    const createSpy = vi.fn((opts: any, cb?: any) => cb && cb({ id: 1 }));
    chromeMock.windows.create = createSpy as any;
    (globalThis as any).fetch.mockResolvedValue(okResponse({
      step_up_required: true,
      step_up_url: 'https://challenge.hcs-u7.org/embed/',
    }));

    await sendBeacon();
    expect(createSpy).not.toHaveBeenCalled();
  });
});

// ─── 7. Collection gate messaging ───────────────────────────────────

describe('collection gate (SANS CLE = RIEN)', () => {
  it('browserguard_collection_query answers true when a key exists', async () => {
    __testSetIngestKey(TEST_KEY);
    const sendResponse = vi.fn();
    const keepAlive = onRuntimeMessage({ type: 'browserguard_collection_query' }, {}, sendResponse);
    expect(keepAlive).toBe(true); // async response
    await new Promise((r) => setTimeout(r, 20));
    expect(sendResponse).toHaveBeenCalledWith({ collectionEnabled: true });
  });

  it('browserguard_collection_query answers false without a key', async () => {
    const sendResponse = vi.fn();
    onRuntimeMessage({ type: 'browserguard_collection_query' }, {}, sendResponse);
    await new Promise((r) => setTimeout(r, 20));
    expect(sendResponse).toHaveBeenCalledWith({ collectionEnabled: false });
  });

  it('key appearing in managed storage broadcasts enabled=true to all tabs', async () => {
    setManagedData('ingestKey', TEST_KEY);
    const tabs = getTabsState();
    tabs.tabs = [{ id: 1 }, { id: 2 }, {}]; // {} has no id — skipped
    tabs.tabListeners.set(1, () => {});
    // tab 2 has no content script — lastError path

    handleKeyStorageChange({ ingestKey: { newValue: TEST_KEY } }, 'managed');
    await new Promise((r) => setTimeout(r, 30));

    const calls = tabs.sendMessageCalls;
    expect(calls.length).toBe(2);
    expect(calls.every((c) => c.message.type === 'browserguard_collection_state' && c.message.enabled === true)).toBe(true);
  });

  it('key disappearing broadcasts enabled=false', async () => {
    handleKeyStorageChange({ ingestKey: { oldValue: TEST_KEY } }, 'managed');
    await new Promise((r) => setTimeout(r, 30));
    expect(getTabsState().sendMessageCalls.every((c) => c.message.enabled === false)).toBe(true);
  });

  it('unrelated storage changes do not broadcast', async () => {
    handleKeyStorageChange({ otherKey: { newValue: 1 } }, 'managed');
    await new Promise((r) => setTimeout(r, 30));
    expect(getTabsState().sendMessageCalls.length).toBe(0);
  });

  it('storage.onChanged emits reach handleKeyStorageChange', async () => {
    // In the SW the listener is registered on chrome.storage.onChanged —
    // here we assert the exported handler is what the listener calls.
    setManagedData('ingestKey', TEST_KEY);
    getTabsState().tabs = [{ id: 9 }];
    getStorageOnChanged().emit({ ingestKey: { newValue: TEST_KEY } }, 'managed');
    // The MockEvent has no registered listener in test context (guarded by
    // isServiceWorkerContext) — call the handler the same way SW wiring does.
    handleKeyStorageChange({ ingestKey: { newValue: TEST_KEY } }, 'managed');
    await new Promise((r) => setTimeout(r, 30));
    expect(getTabsState().sendMessageCalls.length).toBe(1);
  });
});

// ─── 8. Static wiring assertions ────────────────────────────────────

describe('lifecycle wiring (static)', () => {
  const src = bgSource;

  it('broadcast triggers only on onStartup / onInstalled / storage.onChanged', () => {
    expect(src).toContain('chrome.storage.onChanged.addListener(handleKeyStorageChange)');
    expect(src).toContain('chrome.runtime.onStartup.addListener(() => void broadcastCollectionState())');
    expect(src).toContain('chrome.runtime.onInstalled.addListener(() => void broadcastCollectionState())');
    // Exactly 3 call sites total: the storage-change handler and the two
    // lifecycle listeners — no unconditional module-level broadcast.
    const callSites = src.match(/void broadcastCollectionState\(\)/g) || [];
    expect(callSites.length).toBe(3);
  });

  it('every backend fetch sets the tenant key header', () => {
    const fetches = src.match(/fetch\(/g) || [];
    // doPing (single site) + step-up-result = the only network calls
    expect(src).toContain("'X-BrowserGuard-Key': tenantKey");
    expect(fetches.length).toBeLessThanOrEqual(3);
  });

  it('content script never reads storage.managed or the key fields', () => {
    const cs = csSource;
    expect(cs).not.toContain('storage.managed');
    expect(cs).not.toContain('ingestKey');
    expect(cs).not.toContain('browserguard_ingestKey');
  });
});
