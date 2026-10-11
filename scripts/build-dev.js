/**
 * Build script for LOCAL manual testing (Phase 6).
 *
 * Produces dist-dev/ — a development variant that:
 *   - Points at the local stack: hv-api on http://localhost:3001 and
 *     GateGuard on http://localhost:7332 (cogsign-local docker-compose).
 *   - Declares storage.managed_schema so chrome.storage.managed is
 *     readable when a Chrome enterprise policy provisions the ingest key.
 *   - Adds localhost host_permissions + CSP frame-src.
 *   - Keeps the manifest "key" → stable extension ID
 *     jlaahccjnldmmdalfpnagbjajblgnlgf (differs from the Web Store ID).
 *   - Enables __DEBUG__ (browserguard.test in the SW console) and the
 *     dev-only storage.local ingest-key fallback.
 *
 * The production source manifest.json is NEVER modified — the dev
 * manifest is generated here from it.
 */
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, rmSync, readdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const dist = join(root, 'dist-dev');

// ── Clean dist-dev ──
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// ── Common esbuild options (dev) ──
const commonOptions = {
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  platform: 'browser',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
  define: {
    __DEBUG__: 'true',
    __BG_API_BASE__: '"http://localhost:3001"',
    __BG_STEPUP_BASE__: '"http://localhost:7332"',
    __BG_DEV__: 'true',
  },
};

// ── Entry points ──
const entryPoints = [
  { src: 'src/content-script.ts', out: 'src/content-script.js' },
  { src: 'src/background.ts',     out: 'src/background.js' },
  { src: 'src/step-up.ts',        out: 'src/step-up.js' },
];

for (const { src, out } of entryPoints) {
  await build({
    ...commonOptions,
    entryPoints: [join(root, src)],
    outfile: join(dist, out),
  });
  console.log(`[build:dev] ${src} → dist-dev/${out}`);
}

// ── Copy static assets ──
const assets = [
  ['src/step-up.html', 'src/step-up.html'],
  // Dev-only: managed storage schema for chrome.storage.managed
  // (provisioned by the Chrome policy in cogsign-local/chrome-policy/).
  ['managed_schema.json', 'managed_schema.json'],
];

for (const [src, dest] of assets) {
  const srcPath = join(root, src);
  const destPath = join(dist, dest);
  mkdirSync(dirname(destPath), { recursive: true });
  copyFileSync(srcPath, destPath);
  console.log(`[build:dev] ${src} → dist-dev/${dest}`);
}

// ── Generate dev manifest.json (source manifest untouched) ──
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

manifest.host_permissions = [
  ...(manifest.host_permissions || []),
  'http://localhost:3001/*',
  'http://localhost:7332/*',
];

const csp = manifest.content_security_policy?.extension_pages || '';
manifest.content_security_policy = {
  ...manifest.content_security_policy,
  extension_pages: csp.replace(
    /frame-src ([^;]+);?/,
    'frame-src $1 http://localhost:7332;',
  ),
};

// Dev-only: chrome.storage.managed schema (policy-provisioned ingest key)
manifest.storage = { managed_schema: 'managed_schema.json' };

writeFileSync(join(dist, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log('[build:dev] manifest.json → dist-dev/manifest.json (localhost + managed_schema, key kept)');

// ── Copy icons/ directory ──
const iconsSrcDir = join(root, 'icons');
const iconsDestDir = join(dist, 'icons');
if (existsSync(iconsSrcDir)) {
  mkdirSync(iconsDestDir, { recursive: true });
  const iconFiles = readdirSync(iconsSrcDir).filter(f => f.endsWith('.png'));
  for (const f of iconFiles) {
    copyFileSync(join(iconsSrcDir, f), join(iconsDestDir, f));
  }
}

console.log('[build:dev] done');
