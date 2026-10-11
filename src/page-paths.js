/**
 * Canonical internal page paths — defined ONCE, shared by:
 *   - src/background.ts   (chrome.runtime.getURL + sender.url checks)
 *   - scripts/build-dev.js (manifest action.default_popup, copied files)
 * Plain .js (no TS syntax) so Node build scripts can import it directly.
 */
export const STEP_UP_PAGE_PATH = 'src/step-up.html';
export const POPUP_PAGE_PATH = 'src/popup.html';
