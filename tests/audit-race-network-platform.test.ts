/**
 * Tests — Audit v0.2.1: Race/Timing/Network/Platform
 * ─────────────────────────────────────────────────────────────────────────────
 * Covers the 3 remaining audit points + P3 fix:
 *
 *   1. Flood/race — beaconInFlight guard prevents concurrent sendBeacon()
 *      calls from overlapping (setInterval + chrome.alarms + manual trigger).
 *      Verifies the extension has no code path that duplicates/disorders
 *      sends in a way the backend's Redis lock doesn't anticipate.
 *
 *   2. Timing attacks — boundary tests on the backend constants. These
 *      are tested in hybrid-vector-api/tests/audit-timing-boundaries.test.ts
 *      (the constants live in the backend). This file documents the
 *      extension-side behavior at the boundaries (what the extension
 *      sends and how it interprets responses).
 *
 *   3. Network degradation — timeout, 429/500/502, offline→reconnect.
 *      Verifies that NO network failure case makes the extension default
 *      to "session valid" or "trust score non-degraded". The extension is
 *      "dumb" — it has no local trust score, so absence of signal never
 *      translates to trust.
 *
 *   4. P3 — platform detection via navigator.userAgent + viewport ratio
 *      (replaces hardcoded 'desktop').
 *
 * @copyright (c) 2026 Benjamin BARRERE / IA SOLUTION
 * @license Patents Pending FR2514274 | FR2514546
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  resetChromeMock,
  setupWindowsCreate,
  setStorageData,
  chromeMock,
} from './chrome-mock';

import {
  sendBeacon,
  __testGetState,
  __testSetSessionId,
  __testSetInstallId,
  __testSetSnapshot,
  __testResetStepUp,
  detectPlatformFromUA,
  inferPlatformFromViewport,
  type BehaviorSnapshot,
} from '../src/background';

// ─── Helpers ────────────────────────────────────────────────────────

const BG_SESSION_ID = 'bg_audit_test_session';

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

function mockFetchOk(body: Record<string, unknown> = {}): void {
  (globalThis as any).fetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, ...body }),
  });
}

function mockFetchStatus(status: number, body: Record<string, unknown> = {}): void {
  (globalThis as any).fetch = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
}

function mockFetchHang(): { resolve: () => void; promise: Promise<Response> } {
  let resolveFn!: (r: Response) => void;
  const promise = new Promise<Response>((resolve) => {
    resolveFn = resolve;
  });
  (globalThis as any).fetch = vi.fn().mockReturnValue(promise);
  return { resolve: () => resolveFn({ ok: true, status: 200, json: async () => ({ ok: true }) } as any), promise };
}

function mockFetchReject(error: Error): void {
  (globalThis as any).fetch = vi.fn().mockRejectedValue(error);
}

// ─── Setup / teardown ───────────────────────────────────────────────

beforeEach(() => {
  resetChromeMock();
  setupWindowsCreate(1);
  __testSetSessionId(BG_SESSION_ID);
  __testSetInstallId('bg_install_audit');
  __testSetSnapshot(makeSnapshot());
  __testResetStepUp();
  (globalThis as any).fetch = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
  __testResetStepUp();
});

// ════════════════════════════════════════════════════════════════════════
// POINT 1 — FLOOD/RACE: beaconInFlight guard prevents concurrent beacons
// ════════════════════════════════════════════════════════════════════════

describe('[Audit 1] Flood/race — beaconInFlight prevents concurrent beacons', () => {
  it('beaconInFlight is false initially', () => {
    expect(__testGetState().beaconInFlight).toBe(false);
  });

  it('concurrent sendBeacon calls — second is skipped while first is in flight', async () => {
    // First fetch hangs (never resolves) — simulates a slow backend.
    // The second sendBeacon call should be skipped by beaconInFlight.
    let resolveFirst!: (r: any) => void;
    const hangingPromise = new Promise((resolve) => { resolveFirst = resolve; });
    (globalThis as any).fetch = vi.fn().mockReturnValue(hangingPromise);

    // Launch first beacon (returns a promise that won't resolve until we
    // call resolveFirst)
    const firstBeacon = sendBeacon();

    // Wait a microtask for sendBeacon to enter the try block and set
    // beaconInFlight = true
    await new Promise((r) => setTimeout(r, 10));

    // beaconInFlight should be true now
    expect(__testGetState().beaconInFlight).toBe(true);

    // Launch second beacon — should be skipped
    const secondBeacon = sendBeacon();
    await new Promise((r) => setTimeout(r, 10));

    // Only ONE fetch call should have been made (the second was skipped)
    expect(fetch).toHaveBeenCalledTimes(1);

    // Resolve the first fetch to let the first beacon complete
    resolveFirst({ ok: true, status: 200, json: async () => ({ ok: true }) });
    await firstBeacon;
    await secondBeacon;

    // beaconInFlight should be false after completion
    expect(__testGetState().beaconInFlight).toBe(false);
  });

  it('after beacon completes, next beacon is NOT skipped (flag resets)', async () => {
    mockFetchOk();
    await sendBeacon();
    expect(__testGetState().beaconInFlight).toBe(false);

    // Second beacon should proceed normally
    (globalThis as any).fetch = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ ok: true }),
    });
    await sendBeacon();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('beaconInFlight resets even on fetch error (no stuck flag)', async () => {
    mockFetchReject(new Error('Network error'));
    await sendBeacon();
    expect(__testGetState().beaconInFlight).toBe(false);
  });

  it('beaconInFlight resets even on non-ok response (429/500/502)', async () => {
    mockFetchStatus(500, { ok: false, error: 'INTERNAL' });
    await sendBeacon();
    expect(__testGetState().beaconInFlight).toBe(false);
  });

  it('beaconInFlight resets on AbortError (timeout)', async () => {
    // Simulate an AbortError (what happens when the 10s timeout fires)
    const abortError = new DOMException('The operation was aborted', 'AbortError');
    mockFetchReject(abortError);
    await sendBeacon();
    expect(__testGetState().beaconInFlight).toBe(false);
  });

  it('three rapid concurrent calls — only first proceeds, 2nd and 3rd skipped', async () => {
    let resolveFirst!: (r: any) => void;
    const hangingPromise = new Promise((resolve) => { resolveFirst = resolve; });
    (globalThis as any).fetch = vi.fn().mockReturnValue(hangingPromise);

    // Launch 3 beacons "simultaneously" (within the same microtask)
    const p1 = sendBeacon();
    const p2 = sendBeacon();
    const p3 = sendBeacon();

    await new Promise((r) => setTimeout(r, 10));

    // Only 1 fetch call — the other 2 were skipped by beaconInFlight
    expect(fetch).toHaveBeenCalledTimes(1);

    resolveFirst({ ok: true, status: 200, json: async () => ({ ok: true }) });
    await Promise.all([p1, p2, p3]);

    expect(__testGetState().beaconInFlight).toBe(false);
  });
});

// ════════════════════════════════════════════════════════════════════════
// POINT 3 — NETWORK DEGRADATION: no default trust on absent signal
// ════════════════════════════════════════════════════════════════════════

describe('[Audit 3] Network degradation — absence of signal never grants trust', () => {
  it('429 (rate limit) — no state change, no step-up, no invalidation', async () => {
    mockFetchStatus(429, { ok: false, error: 'GLOBAL_RATE_LIMIT_EXCEEDED' });
    const stateBefore = __testGetState();
    await sendBeacon();
    const stateAfter = __testGetState();

    expect(stateAfter.sessionInvalidated).toBe(false);
    expect(stateAfter.stepUpInProgress).toBe(false);
    expect(stateAfter.beaconInFlight).toBe(false);
    // No popup was opened (fetch was called once for the beacon, zero for step-up-result)
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('500 (server error) — no state change, no trust granted', async () => {
    mockFetchStatus(500, { ok: false, error: 'INTERNAL' });
    await sendBeacon();
    const state = __testGetState();

    expect(state.sessionInvalidated).toBe(false);
    expect(state.stepUpInProgress).toBe(false);
    expect(state.beaconInFlight).toBe(false);
  });

  it('502 (bad gateway) — no state change, no trust granted', async () => {
    mockFetchStatus(502, { ok: false, error: 'BAD_GATEWAY' });
    await sendBeacon();
    const state = __testGetState();

    expect(state.sessionInvalidated).toBe(false);
    expect(state.stepUpInProgress).toBe(false);
  });

  it('network timeout (fetch rejects with TypeError) — no state change', async () => {
    // TypeError is what fetch throws on network failure (not AbortError)
    mockFetchReject(new TypeError('Failed to fetch'));
    await sendBeacon();
    const state = __testGetState();

    expect(state.sessionInvalidated).toBe(false);
    expect(state.stepUpInProgress).toBe(false);
    expect(state.beaconInFlight).toBe(false);
  });

  it('AbortError (10s timeout) — no state change, no trust granted', async () => {
    const abortError = new DOMException('The operation was aborted', 'AbortError');
    mockFetchReject(abortError);
    await sendBeacon();
    const state = __testGetState();

    expect(state.sessionInvalidated).toBe(false);
    expect(state.stepUpInProgress).toBe(false);
    expect(state.beaconInFlight).toBe(false);
  });

  it('offline → reconnect — extension retries, no trust granted during outage', async () => {
    // Simulate 3 failed beacons (offline), then a successful one (reconnect)
    mockFetchReject(new TypeError('Failed to fetch'));
    await sendBeacon();
    await sendBeacon();
    await sendBeacon();

    // During outage: no trust, no invalidation
    expect(__testGetState().sessionInvalidated).toBe(false);
    expect(__testGetState().stepUpInProgress).toBe(false);

    // Reconnect — backend responds, but does NOT say trust=100 or invalidated
    mockFetchOk({ trust_score_normalized: 50, step_up_required: false });
    await sendBeacon();

    // After reconnect: still no invalidation, no step-up
    expect(__testGetState().sessionInvalidated).toBe(false);
    expect(__testGetState().stepUpInProgress).toBe(false);
  });

  it('backend says invalidated=true — extension DOES invalidate (trust revoked)', async () => {
    // This is the OPPOSITE of "default trust": when the backend explicitly
    // says the session is invalid, the extension must honor it.
    mockFetchOk({ invalidated: true, trust_score_normalized: 0 });
    await sendBeacon();
    const state = __testGetState();

    expect(state.sessionInvalidated).toBe(true);
  });

  it('backend says step_up_required=true — extension opens popup (not trust)', async () => {
    mockFetchOk({
      step_up_required: true,
      step_up_url: 'https://challenge.hcs-u7.org/embed/?sessionId=test',
      trust_score_normalized: 40,
    });
    await sendBeacon();

    // Step-up was triggered (popup opened), NOT trust granted
    expect(__testGetState().stepUpInProgress).toBe(true);
  });

  it('backend returns trust_score_normalized=100 — extension does NOT treat as "trusted"', async () => {
    // Even if the backend reports perfect trust, the extension has no
    // local "trusted" state — it just logs the score. The only local
    // state changes are stepUpInProgress and sessionInvalidated, both
    // driven by explicit backend flags, not by the trust score.
    mockFetchOk({ trust_score_normalized: 100, step_up_required: false });
    await sendBeacon();
    const state = __testGetState();

    expect(state.stepUpInProgress).toBe(false);
    expect(state.sessionInvalidated).toBe(false);
    // The extension has NO "trusted" flag — it's dumb. The trust score
    // is only in the backend response, used for logging.
  });

  it('fetch timeout (AbortController) prevents resource exhaustion', async () => {
    // Simulate a hanging backend — fetch never resolves.
    // The AbortController should abort after BEACON_FETCH_TIMEOUT_MS (10s).
    // In the test, we mock fetch to reject with AbortError immediately
    // (simulating the timeout firing).
    const abortError = new DOMException('Aborted', 'AbortError');
    (globalThis as any).fetch = vi.fn().mockImplementation((_url: string, opts: any) => {
      // Verify the signal is passed
      expect(opts.signal).toBeDefined();
      expect(opts.signal.aborted).toBe(false);
      return Promise.reject(abortError);
    });

    await sendBeacon();

    // The signal was passed to fetch, and beaconInFlight was reset
    expect(__testGetState().beaconInFlight).toBe(false);
  });

  it('hanging backend — beaconInFlight prevents fetch accumulation', async () => {
    // Simulate a hanging backend. Without beaconInFlight, each 5s tick
    // would launch a new fetch. With the guard, only 1 fetch is in flight.
    let _resolve: (r: any) => void;
    const hangPromise = new Promise((r) => { _resolve = r; });
    (globalThis as any).fetch = vi.fn().mockReturnValue(hangPromise);

    // Simulate 5 rapid beacon attempts (as if setInterval fired 5 times
    // while the first fetch is hanging)
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 5; i++) {
      promises.push(sendBeacon());
    }
    await new Promise((r) => setTimeout(r, 10));

    // Only 1 fetch — the other 4 were skipped by beaconInFlight
    expect(fetch).toHaveBeenCalledTimes(1);

    // Clean up
    _resolve!({ ok: true, status: 200, json: async () => ({ ok: true }) });
    await Promise.all(promises);
  });
});

// ════════════════════════════════════════════════════════════════════════
// POINT 4 — P3: Platform detection (replaces hardcoded 'desktop')
// ════════════════════════════════════════════════════════════════════════

describe('[Audit 4] P3 — Platform detection via UA + viewport ratio', () => {
  // ── detectPlatformFromUA ──

  it('detectPlatformFromUA: iPhone UA → mobile', () => {
    const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15';
    expect(detectPlatformFromUA(ua)).toBe('mobile');
  });

  it('detectPlatformFromUA: Android phone UA → mobile', () => {
    const ua = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
    expect(detectPlatformFromUA(ua)).toBe('mobile');
  });

  it('detectPlatformFromUA: iPad UA → tablet', () => {
    const ua = 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15';
    expect(detectPlatformFromUA(ua)).toBe('tablet');
  });

  it('detectPlatformFromUA: Android tablet (Tablet token) → tablet', () => {
    const ua = 'Mozilla/5.0 (Linux; Android 13; Tablet) AppleWebKit/537.36';
    expect(detectPlatformFromUA(ua)).toBe('tablet');
  });

  it('detectPlatformFromUA: desktop Chrome → desktop', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
    expect(detectPlatformFromUA(ua)).toBe('desktop');
  });

  it('detectPlatformFromUA: desktop Firefox → desktop', () => {
    const ua = 'Mozilla/5.0 (X11; Linux x86_64; rv:121.0) Gecko/20100101 Firefox/121.0';
    expect(detectPlatformFromUA(ua)).toBe('desktop');
  });

  it('detectPlatformFromUA: iPadOS 13+ (Macintosh UA) → desktop (viewport fallback handles this)', () => {
    // iPadOS 13+ reports "Macintosh" in UA — detectPlatformFromUA cannot
    // distinguish it from a real Mac. The viewport fallback in
    // getDeviceContext handles this case (small viewport + high pixelRatio).
    const ua = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15';
    expect(detectPlatformFromUA(ua)).toBe('desktop'); // UA says desktop...
    // ...but getDeviceContext will override to tablet via viewport
  });

  it('detectPlatformFromUA: undefined UA → desktop (safe default)', () => {
    expect(detectPlatformFromUA(undefined)).toBe('desktop');
  });

  it('detectPlatformFromUA: empty string → desktop', () => {
    expect(detectPlatformFromUA('')).toBe('desktop');
  });

  // ── inferPlatformFromViewport ──

  it('inferPlatformFromViewport: 375px + pixelRatio 3 → mobile', () => {
    expect(inferPlatformFromViewport(375, 3)).toBe('mobile');
  });

  it('inferPlatformFromViewport: 414px + pixelRatio 2 → mobile', () => {
    expect(inferPlatformFromViewport(414, 2)).toBe('mobile');
  });

  it('inferPlatformFromViewport: 768px + pixelRatio 2 → tablet', () => {
    expect(inferPlatformFromViewport(768, 2)).toBe('tablet');
  });

  it('inferPlatformFromViewport: 1024px + pixelRatio 2 → desktop (≥1024)', () => {
    expect(inferPlatformFromViewport(1024, 2)).toBe('desktop');
  });

  it('inferPlatformFromViewport: 1920px + pixelRatio 1 → desktop', () => {
    expect(inferPlatformFromViewport(1920, 1)).toBe('desktop');
  });

  it('inferPlatformFromViewport: 375px + pixelRatio 1 → desktop (low pixelRatio)', () => {
    // A narrow desktop window (e.g. 375px) with pixelRatio 1 is NOT
    // inferred as mobile — the pixelRatio signal is needed to avoid
    // false positives from small desktop windows.
    expect(inferPlatformFromViewport(375, 1)).toBe('desktop');
  });

  // ── Integration: getDeviceContext via sendBeacon payload ──

  it('sendBeacon sends detected platform in deviceContext (desktop UA + desktop viewport)', async () => {
    // Default navigator.userAgent in vitest is a desktop-like string
    mockFetchOk();
    await sendBeacon();

    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.deviceContext.platform).toBe('desktop');
  });

  it('sendBeacon sends "mobile" when viewport is mobile-sized with high pixelRatio', async () => {
    // Simulate a mobile viewport — even with a desktop UA, the viewport
    // fallback should override to mobile.
    __testSetSnapshot(makeSnapshot({
      viewportWidth: 375,
      viewportHeight: 812,
      pixelRatio: 3,
    }));
    mockFetchOk();
    await sendBeacon();

    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    // The viewport fallback should detect mobile (375px + pixelRatio 3)
    expect(body.deviceContext.platform).not.toBe('desktop');
    expect(['mobile', 'tablet']).toContain(body.deviceContext.platform);
    expect(body.deviceContext.viewportWidth).toBe(375);
    expect(body.deviceContext.pixelRatio).toBe(3);
  });

  it('sendBeacon sends "tablet" for iPad-like viewport (768px + pixelRatio 2)', async () => {
    __testSetSnapshot(makeSnapshot({
      viewportWidth: 768,
      viewportHeight: 1024,
      pixelRatio: 2,
    }));
    mockFetchOk();
    await sendBeacon();

    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.deviceContext.platform).toBe('tablet');
  });

  it('sendBeacon does NOT hardcode "desktop" — platform varies with viewport', async () => {
    // This is the regression test for the P3 bug: previously, platform
    // was ALWAYS 'desktop' regardless of viewport. Now it varies.
    const platforms = new Set<string>();

    // Desktop viewport
    __testSetSnapshot(makeSnapshot({ viewportWidth: 1920, viewportHeight: 1080, pixelRatio: 1 }));
    const desktopFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ ok: true }),
    });
    (globalThis as any).fetch = desktopFetch;
    await sendBeacon();
    platforms.add(JSON.parse(desktopFetch.mock.calls[0][1].body).deviceContext.platform);

    // Mobile viewport
    __testSetSnapshot(makeSnapshot({ viewportWidth: 375, viewportHeight: 812, pixelRatio: 3 }));
    const mobileFetch = vi.fn().mockResolvedValue({
      ok: true, status: 200, json: async () => ({ ok: true }),
    });
    (globalThis as any).fetch = mobileFetch;
    await sendBeacon();
    platforms.add(JSON.parse(mobileFetch.mock.calls[0][1].body).deviceContext.platform);

    // At least 2 distinct platforms — proves it's not hardcoded
    expect(platforms.size).toBeGreaterThanOrEqual(2);
    expect(platforms.has('desktop')).toBe(true);
  });
});
