# BrowserGuard — Extension Icons

This directory holds the PNG icons referenced by `manifest.json`.

## Required files

| File | Dimensions | Used by |
|------|-----------|---------|
| `icon16.png` | 16×16 px | Toolbar icon (small), favicon |
| `icon32.png` | 32×32 px | Toolbar icon (retina), Windows taskbar |
| `icon48.png` | 48×48 px | Extensions management page (chrome://extensions) |
| `icon128.png` | 128×128 px | Chrome Web Store listing, install dialog |

## Notes

- Chrome requires PNG format (alpha transparency supported).
- The 128×128 icon is the most visible — it appears on the Web Store
  listing and the install dialog. Invest the most design effort there.
- All four sizes should use the same visual (just scaled), not
  different compositions.
- The manifest references these paths as `icons/iconNN.png`. The build
  scripts (`scripts/build.js` and `scripts/build-publish.js`) copy the
  entire `icons/` directory to `dist/icons/` and `dist-publish/icons/`.
- Until the PNGs are deposited here, Chrome will show a clear
  "Could not load icon" error on extension load — this is intentional
  (a useful signal, not a silent failure).
