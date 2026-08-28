/**
 * Copy non-TS assets (manifest.json, step-up.html) to dist/ after build.
 * Run automatically by `npm run build`.
 */
import { copyFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

const assets = [
  ['manifest.json', 'manifest.json'],
  ['src/step-up.html', 'src/step-up.html'],
];

for (const [src, dest] of assets) {
  const srcPath = join(root, src);
  const destPath = join(root, 'dist', dest);
  if (existsSync(srcPath)) {
    mkdirSync(dirname(destPath), { recursive: true });
    copyFileSync(srcPath, destPath);
    console.log(`[copy] ${src} → dist/${dest}`);
  }
}
console.log('[copy] done');
