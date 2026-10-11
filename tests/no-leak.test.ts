/**
 * Phase 6b — privacy non-leak tests.
 *
 * 1. RUNTIME: capture the actual bodies sent by sendBeacon() and
 *    notifyStepUpEnd() through a mocked fetch, then recursively inspect
 *    them for forbidden keys (url/href/title/referrer/…) or URL-like
 *    values that don't belong to the backend endpoints.
 * 2. STATIC: every fetch( in background.ts must target BACKEND_URL or a
 *    derivation of it (the step-up-result replace) — no hard-coded URL.
 *    No fetch in content-script.ts or step-up.ts at all.
 *    No line numbers / fixed text blocks — pattern-based only.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import './chrome-mock';
import { resetChromeMock } from './chrome-mock';

import bgSource from '../src/background.ts?raw';
import csSource from '../src/content-script.ts?raw';
import suSource from '../src/step-up.ts?raw';

import {
  sendBeacon,
  notifyStepUpEnd,
  __testResetStepUp,
  __testSetIngestKey,
  __testSetSnapshot,
  __testSetSessionId,
  __testSetInstallId,
} from '../src/background';

const TEST_KEY = 'a'.repeat(64);

const FORBIDDEN_KEYS = new Set([
  'url', 'href', 'title', 'referrer', 'location', 'pageurl', 'pagetitle',
  'documenttitle', 'innerhtml', 'outerhtml', 'textcontent', 'value',
]);

function scanKeys(node: unknown, path: string, violations: string[]): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((v, i) => scanKeys(v, `${path}[${i}]`, violations));
    return;
  }
  for (const [k, v] of Object.entries(node)) {
    if (FORBIDDEN_KEYS.has(k.toLowerCase())) {
      violations.push(`${path}.${k}`);
    }
    if (typeof v === 'string' && /^https?:\/\//.test(v)) {
      violations.push(`${path}.${k} = URL value "${v.slice(0, 60)}"`);
    }
    scanKeys(v, `${path}.${k}`, violations);
  }
}

function capturedBodies(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown>[] {
  return fetchMock.mock.calls.map((c) => JSON.parse((c[1] as { body: string }).body));
}

describe('payload non-leak (runtime)', () => {
  beforeEach(() => {
    resetChromeMock();
    vi.restoreAllMocks();
    __testResetStepUp();
    __testSetIngestKey(TEST_KEY);
    __testSetSessionId('bg_test_session');
    __testSetInstallId('bg_install_test');
    __testSetSnapshot({
      keystrokeIntervals: [100, 110], keystrokeHolds: [50, 60], keystrokeCount: 2,
      mouseSpeeds: [300, 320], mouseCurvatures: [0.5, 0.6], mousePauseCount: 1, mouseEventCount: 5,
      scrollSpeeds: [200], scrollPauseCount: 0, scrollEventCount: 1,
      totalEvents: 8, timestamp: new Date().toISOString(),
      viewportWidth: 1920, viewportHeight: 1080, pixelRatio: 1,
    });
  });

  it('beacon body contains no page URL / title / content keys', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true }) });
    (globalThis as any).fetch = fetchMock;

    await sendBeacon();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const violations: string[] = [];
    for (const body of capturedBodies(fetchMock)) {
      scanKeys(body, '$', violations);
    }
    expect(violations).toEqual([]);
  });

  it('step-up-result body contains no page URL / title / content keys', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    (globalThis as any).fetch = fetchMock;

    await notifyStepUpEnd('bg_test_session', true, 'GO', 90, 0.9, 'proof-x');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const violations: string[] = [];
    for (const body of capturedBodies(fetchMock)) {
      scanKeys(body, '$', violations);
    }
    expect(violations).toEqual([]);
  });

  it('every fetch targets the backend endpoints only', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
    (globalThis as any).fetch = fetchMock;

    await sendBeacon();
    await notifyStepUpEnd('bg_test_session', true, 'GO', 90, 0.9, 'pt');

    for (const call of fetchMock.mock.calls) {
      const target = String(call[0]);
      // Both endpoints live under the API base — same host, /api/browserguard/*
      expect(target).toMatch(/\/api\/browserguard\/(session-behavior-ping|step-up-result)$/);
    }
  });
});

describe('static wiring — fetch only reaches BACKEND_URL derivations', () => {
  it('every fetch( in background.ts uses BACKEND_URL (or its replace())', () => {
    // Capture the first non-) chars after fetch( ; drop empty-arg matches
    // like the "raw fetch()" mention in comments.
    const fetchCalls = (bgSource.match(/fetch\([^)]*/g) ?? [])
      .filter((c) => c.trim().length > 'fetch('.length);
    expect(fetchCalls.length).toBeGreaterThan(0);
    for (const call of fetchCalls) {
      expect(call).toMatch(/fetch\(`?\$?\{?BACKEND_URL/);
    }
  });

  it('content-script.ts and step-up.ts contain no fetch/sendBeacon/XHR', () => {
    for (const src of [csSource, suSource]) {
      expect(src).not.toMatch(/\bfetch\(/);
      expect(src).not.toMatch(/sendBeacon\(/);
      expect(src).not.toMatch(/XMLHttpRequest/);
    }
  });

  it('the snapshot message carries no url/href/title field', () => {
    // Find the browserguard_behavior_snapshot sendMessage block and check
    // none of its keys is a page identifier. Pattern-based, no line refs.
    const m = csSource.match(/browserguard_behavior_snapshot'[\s\S]{0,400}?\}\);/);
    expect(m).not.toBeNull();
    expect(m![0]).not.toMatch(/\b(url|href|title|referrer)\s*:/);
  });
});
