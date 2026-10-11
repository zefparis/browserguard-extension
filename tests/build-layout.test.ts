/**
 * Phase 6b — built-artifact layout checks.
 *
 * Verifies (post-build) that dist-dev/ ships the popup + step-up pages at
 * the EXACT paths declared by the shared constants in src/page-paths.js —
 * the same constants used by the SW sender guard and chrome.runtime.getURL.
 * Also checks dist-publish ships step-up.html at the same path and that
 * the dev manifest's action.default_popup equals POPUP_PAGE_PATH.
 *
 * Uses import.meta.glob (non-eager) — no node:fs dependency. The dist
 * assertions are skipped when the folders haven't been built yet, so a
 * bare `npx vitest` on a clean checkout still passes; run after
 * `npm run build:dev && npm run build:publish` for the real check.
 */
/// <reference types="vite/client" />
import { describe, it, expect } from 'vitest';
import { STEP_UP_PAGE_PATH, POPUP_PAGE_PATH } from '../src/page-paths.js';

// import.meta.glob must stay a literal call — Vite replaces it during
// file transformation (binding it to a variable breaks the transform).
const distDev = import.meta.glob('../dist-dev/**/*', { query: '?raw', import: 'default' });
const distPub = import.meta.glob('../dist-publish/**/*', { query: '?raw', import: 'default' });

const hasDistDev = Object.keys(distDev).length > 0;
const hasDistPub = Object.keys(distPub).length > 0;

describe('page path constants', () => {
  it('constants carry the canonical src/ paths', () => {
    expect(STEP_UP_PAGE_PATH).toBe('src/step-up.html');
    expect(POPUP_PAGE_PATH).toBe('src/popup.html');
  });
});

describe.skipIf(!hasDistDev)('dist-dev layout (post build:dev)', () => {
  it('ships step-up page + bundle at STEP_UP_PAGE_PATH', () => {
    expect(distDev[`../dist-dev/${STEP_UP_PAGE_PATH}`]).toBeDefined();
    expect(distDev['../dist-dev/src/step-up.js']).toBeDefined();
  });

  it('ships popup page + bundle at POPUP_PAGE_PATH', () => {
    expect(distDev[`../dist-dev/${POPUP_PAGE_PATH}`]).toBeDefined();
    expect(distDev['../dist-dev/src/popup.js']).toBeDefined();
  });

  it('dev manifest action.default_popup === POPUP_PAGE_PATH', async () => {
    const raw = await (distDev['../dist-dev/manifest.json'] as () => Promise<string>)();
    const manifest = JSON.parse(raw);
    expect(manifest.action?.default_popup).toBe(POPUP_PAGE_PATH);
  });
});

describe.skipIf(!hasDistPub)('dist-publish layout (post build:publish)', () => {
  it('ships step-up.html at the same src/ path', () => {
    expect(distPub[`../dist-publish/${STEP_UP_PAGE_PATH}`]).toBeDefined();
  });

  it('ships NO popup — action.default_popup absent from publish manifest', async () => {
    const raw = await (distPub['../dist-publish/manifest.json'] as () => Promise<string>)();
    const manifest = JSON.parse(raw);
    expect(manifest.action?.default_popup).toBeUndefined();
    expect(distPub['../dist-publish/src/popup.html']).toBeUndefined();
    expect(distPub['../dist-publish/src/popup.js']).toBeUndefined();
  });
});
