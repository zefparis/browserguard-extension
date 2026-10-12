/**
 * Build script — esbuild for each entry point, producing standalone IIFEs.
 *
 * Chrome MV3 constraints:
 *   - content_scripts: classic scripts (no export/import) → format: 'iife'
 *   - background service worker: can be module ("type": "module" in manifest)
 *     but we build it as iife too for consistency and to avoid residual exports
 *   - step-up.js: loaded by step-up.html via <script src>, classic script → iife
 *
 * esbuild bundles all imports into a single file per entry point, so there
 * are no residual export/import statements in the output.
 */
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, rmSync, readdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const dist = join(root, 'dist');

// ── Clean dist ──
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// ── Common esbuild options ──
const commonOptions = {
  bundle: true,
  format: 'iife',       // immediately-invoked function expression — no export/import
  target: 'chrome120',  // MV3 requires modern Chrome
  platform: 'browser',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
  // __DEBUG__ is true in dev builds — enables the browserguard.test API
  // on globalThis for manual testing from the SW DevTools console.
  // In production (build-publish.js), __DEBUG__ is false and the entire
  // debug block is tree-shaken out by esbuild.
  // __BG_*: build-time endpoints. Production literals are the defaults —
  // this build keeps production endpoints; only build-dev.js overrides
  // them to localhost. __BG_DEV__ stays false here (no local fallback).
  define: {
    __DEBUG__: 'true',
    __BG_API_BASE__: '"https://api.hcs-u7.org/hv"',
    __BG_STEPUP_BASE__: '"https://challenge.hcs-u7.org"',
    __BG_DEV__: 'false',
  },
};

// ── Entry points ──
const entryPoints = [
  { src: 'src/content-script.ts', out: 'src/content-script.js' },
  { src: 'src/background.ts',     out: 'src/background.js' },
  { src: 'src/step-up.ts',        out: 'src/step-up.js' },
  { src: 'src/options.ts',        out: 'src/options.js' },
];

// ── Build all entry points ──
for (const { src, out } of entryPoints) {
  await build({
    ...commonOptions,
    entryPoints: [join(root, src)],
    outfile: join(dist, out),
  });
  console.log(`[build] ${src} → dist/${out}`);
}

// ── Copy static assets ──
const assets = [
  ['manifest.json', 'manifest.json'],
  ['src/step-up.html', 'src/step-up.html'],
  ['src/options.html', 'src/options.html'],
  // Managed storage schema — declares the ingestKey policy so
  // chrome.storage.managed exists in ALL builds (policy wins over the
  // options-page key).
  ['managed_schema.json', 'managed_schema.json'],
];

for (const [src, dest] of assets) {
  const srcPath = join(root, src);
  const destPath = join(dist, dest);
  mkdirSync(dirname(destPath), { recursive: true });
  copyFileSync(srcPath, destPath);
  console.log(`[copy] ${src} → dist/${dest}`);
}

// ── Copy icons/ directory (if it contains PNGs) ──
const iconsSrcDir = join(root, 'icons');
const iconsDestDir = join(dist, 'icons');
if (existsSync(iconsSrcDir)) {
  mkdirSync(iconsDestDir, { recursive: true });
  const iconFiles = readdirSync(iconsSrcDir).filter(f => f.endsWith('.png'));
  for (const f of iconFiles) {
    copyFileSync(join(iconsSrcDir, f), join(iconsDestDir, f));
    console.log(`[copy] icons/${f} → dist/icons/${f}`);
  }
  if (iconFiles.length === 0) {
    console.log('[copy] icons/ exists but contains no PNGs — manifest references will fail to load until icons are deposited');
  }
}

console.log('[build] done');
