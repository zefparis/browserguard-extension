/**
 * BrowserGuard — Step-up page (internal extension page)
 * ─────────────────────────────────────────────────────────────────────────────
 * This page runs at chrome-extension://<id>/src/step-up.html.
 * It embeds the GateGuard /embed/ iframe (challenge.hcs-u7.org/embed/)
 * and relays the postMessage result back to the background service worker
 * via chrome.runtime.sendMessage.
 *
 * Verdict (Phase 6b): after the iframe result is relayed, the page WAITS
 * for the service worker's response — which carries the SERVER decision
 * (accepted/rejected by /step-up-result) — before showing "validée" or
 * "non validée". 8s deadline → neutral message; a server-rejected GO is
 * NEVER shown as passed. postMessage/origin/proof logic is unchanged.
 *
 * @copyright (c) 2026 Benjamin BARRERE / IA SOLUTION
 * @license Patents Pending FR2514274 | FR2514546
 */

import { t, detectLang } from './i18n';

// Dev-build flag injected by esbuild `define` (false/absent in prod).
declare const __BG_DEV__: boolean;

(function () {
  'use strict';

  const lang = detectLang();
  document.documentElement.lang = lang;

  const VERDICT_WAIT_MS = 8_000;   // max wait for the SW/server verdict
  const VERDICT_SHOW_MS = 3_000;   // how long the verdict stays visible

  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('sessionId') || '';
  const tenantId = params.get('tenantId') || '';
  const callbackOrigin = params.get('callbackOrigin') || '';
  const stepUpUrl = params.get('stepUpUrl') || '';

  const loading = document.getElementById('loading')!;
  const container = document.getElementById('iframe-container')!;
  const iframe = document.getElementById('stepup-iframe') as HTMLIFrameElement;
  const intro = document.getElementById('intro')!;
  const verdictEl = document.getElementById('verdict')!;
  const verdictIcon = document.getElementById('verdict-icon')!;
  const verdictText = document.getElementById('verdict-text')!;
  const verdictSub = document.getElementById('verdict-sub')!;

  intro.textContent = t('stepup.intro', lang);
  loading.textContent = t('stepup.loading', lang);

  function showError(textKey: string, extra?: string): void {
    loading.style.display = 'flex';
    const div = document.createElement('div');
    div.className = 'v-error';
    div.textContent = t('stepup.error', lang) + t(textKey, lang) + (extra ? ' ' + extra : '');
    loading.replaceChildren(div);
    container.style.display = 'none';
  }

  // Verdict display — 'ok' | 'ko' | 'neutral'. Auto-closes after
  // VERDICT_SHOW_MS; the user can always close the window manually.
  function showVerdict(kind: 'ok' | 'ko' | 'neutral', textKey: string, subKey?: string): void {
    iframe.src = 'about:blank';
    container.style.display = 'none';
    loading.style.display = 'none';
    intro.style.display = 'none';
    verdictEl.className = kind;
    verdictEl.style.display = 'flex';
    verdictIcon.textContent = kind === 'ok' ? '✓' : kind === 'ko' ? '✗' : '…';
    verdictText.textContent = t(textKey, lang);
    verdictSub.textContent = subKey ? t(subKey, lang) : '';
    setTimeout(() => window.close(), VERDICT_SHOW_MS);
  }

  if (!stepUpUrl) {
    console.error('[step-up] Missing stepUpUrl query param');
    showError('stepup.no_direct');
    chrome.runtime.sendMessage({
      type: 'browserguard_stepup_error',
      error: 'missing_stepup_url',
      detail: 'stepUpUrl query param is required',
      sessionId,
    });
    return;
  }

  // The callbackOrigin for the GateGuard iframe must be THIS extension page's origin
  // (chrome-extension://<id>), not the original callbackOrigin from the background.
  const extensionOrigin = `chrome-extension://${chrome.runtime.id}`;

  // Build the GateGuard embed URL
  const embedParams = new URLSearchParams({
    sessionId,
    tenantId,
    callbackOrigin: extensionOrigin,
    userId: `browserguard_${sessionId}`,
  });
  const embedUrl = `${stepUpUrl}?${embedParams.toString()}`;

  // Load the iframe
  iframe.src = embedUrl;
  loading.style.display = 'none';
  container.style.display = 'block';

  // ─── Iframe error handling ──────────────────────────────────────
  // If the iframe fails to load (CSP, network, etc.), show a visible
  // error instead of a silent "broken image" icon.
  iframe.addEventListener('error', () => {
    showError('stepup.iframe_failed');
    chrome.runtime.sendMessage({
      type: 'browserguard_stepup_error',
      error: 'iframe_load_failed',
      detail: `Failed to load iframe from ${stepUpUrl}`,
      sessionId,
    });
  });

  // Detect load failure via timeout (iframe 'error' event is unreliable
  // for cross-origin iframes — Chrome often doesn't fire it)
  let iframeLoaded = false;
  iframe.addEventListener('load', () => { iframeLoaded = true; });
  setTimeout(() => {
    if (!iframeLoaded) {
      showError('stepup.iframe_timeout');
      chrome.runtime.sendMessage({
        type: 'browserguard_stepup_error',
        error: 'iframe_load_timeout',
        detail: `Iframe did not load within 10s from ${stepUpUrl}`,
        sessionId,
      });
    }
  }, 10_000);

  // ─── Listen for postMessage from the GateGuard iframe ─────────────

  // SECURITY: Only accept postMessage from the GateGuard embed iframe.
  // The iframe is loaded from challenge.hcs-u7.org (or the configured
  // step-up domain). Without this check, any page/iframe that can load
  // step-up.html (via web_accessible_resources) could forge a
  // 'browserguard_stepup_result' message with decision='GO' and bypass
  // the cognitive challenge entirely.
  const TRUSTED_ORIGINS = new Set([
    'https://challenge.hcs-u7.org',
    'https://api.hcs-u7.org',
  ]);

  // Dev builds only (esbuild define __BG_DEV__): trust the local
  // GateGuard origin for local manual testing. The literal is
  // tree-shaken out of production bundles (__BG_DEV__ = false + minify).
  if (typeof __BG_DEV__ !== 'undefined' && __BG_DEV__) {
    TRUSTED_ORIGINS.add('http://localhost:7332');
  }

  let verdictSettled = false;

  window.addEventListener('message', (event) => {
    // Reject messages from untrusted origins
    if (!TRUSTED_ORIGINS.has(event.origin)) return;

    const data = event.data;

    if (!data || typeof data !== 'object') return;

    if (data.type === 'browserguard_stepup_result' && !verdictSettled) {
      verdictSettled = true;
      // Relay to background service worker and WAIT for the server-side
      // verdict: the SW answers {success, code} after /step-up-result.
      // SECURITY: proofToken is a signed attestation from GateGuard that
      // the cognitive challenge was really completed with a GO decision.
      // /step-up-result rejects GO without a valid proofToken.
      const deadline = setTimeout(() => {
        showVerdict('neutral', 'stepup.pending');
      }, VERDICT_WAIT_MS);

      try {
        chrome.runtime.sendMessage({
          type: 'browserguard_stepup_result',
          decision: data.decision,
          score: data.score,
          confidence: data.confidence,
          engaged: data.engaged,
          reason: data.reason,
          sessionId: data.sessionId,
          completedCount: data.completedCount,
          plannedCount: data.plannedCount,
          proofToken: data.proofToken || null,
        }, (resp: { success?: boolean; code?: string } | undefined) => {
          clearTimeout(deadline);
          if (chrome.runtime.lastError || !resp) {
            showVerdict('neutral', 'stepup.pending');
            return;
          }
          // NEVER "validée" on a server reject — even if the iframe said GO.
          if (resp.success === true) {
            showVerdict('ok', 'stepup.success');
          } else {
            showVerdict('ko', 'stepup.failure', 'stepup.not_recorded');
          }
        });
      } catch {
        clearTimeout(deadline);
        showVerdict('neutral', 'stepup.pending');
      }
    }

    if (data.type === 'browserguard_stepup_error') {
      chrome.runtime.sendMessage({
        type: 'browserguard_stepup_error',
        error: data.error,
        detail: data.detail,
        sessionId: data.sessionId,
      });
      setTimeout(() => window.close(), 1000);
    }
  });

  // ─── Timeout: close if no result after 60s ────────────────────────

  setTimeout(() => {
    if (verdictSettled) return; // verdict flow already owns the window
    chrome.runtime.sendMessage({
      type: 'browserguard_stepup_error',
      error: 'stepup_timeout',
      detail: 'No result received within 60 seconds',
      sessionId,
    });
    window.close();
  }, 60_000);
})();
