/**
 * Build script for Chrome Web Store publication.
 *
 * Same esbuild compilation as scripts/build.js, but:
 *   - Outputs to dist-publish/ (never touches dist/)
 *   - Strips the "key" field from manifest.json (rejected by Web Store)
 *   - Zips the result into browserguard-vX.zip at the repo root
 *
 * Usage:
 *   npm run build:publish
 *
 * Output:
 *   dist-publish/          — unpacked extension (no "key" field)
 *   browserguard-v0.1.0.zip — ready to upload to Chrome Web Store
 */
import { build } from 'esbuild';
import { copyFileSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
const distPublish = join(root, 'dist-publish');

// ── Clean dist-publish ──
rmSync(distPublish, { recursive: true, force: true });
mkdirSync(distPublish, { recursive: true });

// ── Common esbuild options (identical to build.js) ──
const commonOptions = {
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  platform: 'browser',
  sourcemap: false,
  legalComments: 'none',
  logLevel: 'info',
};

const entryPoints = [
  { src: 'src/content-script.ts', out: 'src/content-script.js' },
  { src: 'src/background.ts',     out: 'src/background.js' },
  { src: 'src/step-up.ts',        out: 'src/step-up.js' },
];

// ── Build all entry points ──
for (const { src, out } of entryPoints) {
  await build({
    ...commonOptions,
    entryPoints: [join(root, src)],
    outfile: join(distPublish, out),
  });
  console.log(`[build:publish] ${src} → dist-publish/${out}`);
}

// ── Copy static assets ──
const assets = [
  ['src/step-up.html', 'src/step-up.html'],
];

for (const [src, dest] of assets) {
  const srcPath = join(root, src);
  const destPath = join(distPublish, dest);
  mkdirSync(dirname(destPath), { recursive: true });
  copyFileSync(srcPath, destPath);
  console.log(`[build:publish] ${src} → dist-publish/${dest}`);
}

// ── Generate manifest.json WITHOUT the "key" field ──
const manifestSrc = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));

// Strip the "key" field — Chrome Web Store rejects it:
//   "Le champ key n'est pas autorisé dans le fichier manifeste."
if (manifestSrc.key) {
  delete manifestSrc.key;
  console.log('[build:publish] Stripped "key" field from manifest.json (Web Store requirement)');
}

const manifestDestPath = join(distPublish, 'manifest.json');
writeFileSync(manifestDestPath, JSON.stringify(manifestSrc, null, 2) + '\n');
console.log('[build:publish] manifest.json → dist-publish/manifest.json (no "key")');

// ── Verify no "key" remains ──
const verify = JSON.parse(readFileSync(manifestDestPath, 'utf8'));
if (verify.key) {
  console.error('[build:publish] FATAL: "key" field still present in output manifest!');
  process.exit(1);
}

// ── Zip the output ──
const version = manifestSrc.version || '0.0.0';
const zipName = `browserguard-v${version}.zip`;
const zipPath = join(root, zipName);

// Remove old zip if exists
if (existsSync(zipPath)) rmSync(zipPath);

// Create zip from inside dist-publish/ so paths are relative (manifest.json at root)
execSync(`cd "${distPublish}" && zip -r "${zipPath}" .`, { stdio: 'pipe' });
console.log(`[build:publish] Created ${zipName} (${zipPath})`);

// ── Post-zip verification ──────────────────────────────────────────────
// Guard against regressions that caused Chrome Web Store rejections in the
// past: forbidden permissions, source files leaking into the package, or
// manifest.json not being at the archive root.
const zipListing = execSync(`unzip -l "${zipPath}"`, { encoding: 'utf8' });
const zipFiles = zipListing.split('\n').map(l => l.trim()).filter(Boolean);

// Check 1: manifest.json at root (unzip -l format: "Length  Date  Time  Name")
const hasManifestAtRoot = zipFiles.some(l => /\s+manifest\.json\s*$/.test(l) && !/src\/manifest\.json/.test(l));
if (!hasManifestAtRoot) {
  console.error('[build:publish] FATAL: manifest.json not found at zip root!');
  console.error(zipListing);
  process.exit(1);
}

// Check 2: no source files, node_modules, or .git
const forbiddenPatterns = [/\.ts$/, /node_modules/, /\.git/, /package\.json/, /package-lock/, /tsconfig/, /vitest/, /scripts\//];
const leaked = zipFiles.filter(l =>
  forbiddenPatterns.some(p => p.test(l)) && !/Name$/.test(l) && !/^---/.test(l) && !/^Length/.test(l) && !/^files$/.test(l),
);
if (leaked.length > 0) {
  console.error('[build:publish] FATAL: forbidden files leaked into zip:');
  leaked.forEach(f => console.error(`  ${f}`));
  process.exit(1);
}

// Check 3: no forbidden permissions (regression guard for scripting/activeTab)
const FORBIDDEN_PERMISSIONS = ['scripting', 'activeTab'];
const manifestInZip = execSync(`unzip -p "${zipPath}" manifest.json`, { encoding: 'utf8' });
const manifestJson = JSON.parse(manifestInZip);
const declaredPerms = manifestJson.permissions || [];
const forbiddenFound = FORBIDDEN_PERMISSIONS.filter(p => declaredPerms.includes(p));
if (forbiddenFound.length > 0) {
  console.error(`[build:publish] FATAL: forbidden permissions in manifest: ${forbiddenFound.join(', ')}`);
  console.error('These permissions were removed for Chrome Web Store compliance and must not return.');
  process.exit(1);
}

console.log('[build:publish] Post-zip checks passed (manifest at root, no source leaks, no forbidden permissions)');

// ── Summary ──
console.log('');
console.log('[build:publish] ═══════════════════════════════════════════════════');
console.log(`[build:publish]  Output:  dist-publish/ (unpacked, no "key")`);
console.log(`[build:publish]  Zip:     ${zipName}`);
console.log(`[build:publish]  Path:    ${zipPath}`);
console.log(`[build:publish]  Version: ${version}`);
console.log('[build:publish] ═══════════════════════════════════════════════════');
console.log('[build:publish] done');
