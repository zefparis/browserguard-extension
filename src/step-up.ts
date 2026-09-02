/**
 * BrowserGuard — Step-up page (internal extension page)
 * ─────────────────────────────────────────────────────────────────────────────
 * This page runs at chrome-extension://<id>/src/step-up.html.
 * It embeds the GateGuard /embed/ iframe (challenge.hcs-u7.org/embed/)
 * and relays the postMessage result back to the background service worker
 * via chrome.runtime.sendMessage.
 *
 * Flow:
 *   1. Read query params: sessionId, tenantId, callbackOrigin, stepUpUrl
 *   2. Build the GateGuard embed URL with callbackOrigin=chrome-extension://<id>
 *   3. Load the iframe
 *   4. Listen for window.message events from the iframe
 *   5. Relay result to background.ts via chrome.runtime.sendMessage
 *   6. Auto-close the window
 *
 * @copyright (c) 2026 Benjamin BARRERE / IA SOLUTION
 * @license Patents Pending FR2514274 | FR2514546
 */

(function () {
  'use strict';

  const params = new URLSearchParams(window.location.search);
  const sessionId = params.get('sessionId') || '';
  const tenantId = params.get('tenantId') || '';
  const callbackOrigin = params.get('callbackOrigin') || '';
  const stepUpUrl = params.get('stepUpUrl') || '';

  if (!stepUpUrl) {
    console.error('[step-up] Missing stepUpUrl query param');
    // Show visual error instead of silently closing
    const loading = document.getElementById('loading');
    if (loading) {
      loading.innerHTML = '<div style="color:#ef4444;font-size:14px;text-align:center;padding:20px;">'
        + 'Erreur: cette page ne peut pas être ouverte directement.<br>'
        + 'Elle est appelée automatiquement par BrowserGuard lors d\'un step-up.'
        + '</div>';
    }
    chrome.runtime.sendMessage({
      type: 'browserguard_stepup_error',
      error: 'missing_stepup_url',
      detail: 'stepUpUrl query param is required',
      sessionId,
    });
    // Don't auto-close — let the user see the error
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
  const loading = document.getElementById('loading')!;
  const container = document.getElementById('iframe-container')!;
  const iframe = document.getElementById('stepup-iframe') as HTMLIFrameElement;

  iframe.src = embedUrl;
  loading.style.display = 'none';
  container.style.display = 'block';

  // ─── Iframe error handling ──────────────────────────────────────
  // If the iframe fails to load (CSP, network, etc.), show a visible
  // error instead of a silent "broken image" icon.
  iframe.addEventListener('error', () => {
    loading.style.display = 'flex';
    loading.innerHTML = '<div style="color:#ef4444;font-size:13px;text-align:center;padding:20px;">'
      + 'Erreur: impossible de charger le challenge.<br>'
      + 'URL: ' + embedUrl
      + '</div>';
    container.style.display = 'none';
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
      loading.style.display = 'flex';
      loading.innerHTML = '<div style="color:#ef4444;font-size:13px;text-align:center;padding:20px;">'
        + 'Erreur: le challenge n\'a pas répondu dans les 10s.<br>'
        + 'URL: ' + embedUrl
        + '</div>';
      container.style.display = 'none';
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

  window.addEventListener('message', (event) => {
    // Reject messages from untrusted origins
    if (!TRUSTED_ORIGINS.has(event.origin)) return;

    const data = event.data;

    if (!data || typeof data !== 'object') return;

    if (data.type === 'browserguard_stepup_result') {
      // Relay to background service worker
      // SECURITY: proofToken is a signed attestation from GateGuard that
      // the cognitive challenge was really completed with a GO decision.
      // /step-up-result rejects GO without a valid proofToken.
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
      });
      // Auto-close after a short delay
      setTimeout(() => window.close(), 500);
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
    chrome.runtime.sendMessage({
      type: 'browserguard_stepup_error',
      error: 'stepup_timeout',
      detail: 'No result received within 60 seconds',
      sessionId,
    });
    window.close();
  }, 60_000);
})();
