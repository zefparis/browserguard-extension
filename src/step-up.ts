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
    chrome.runtime.sendMessage({
      type: 'browserguard_stepup_error',
      error: 'missing_stepup_url',
      detail: 'stepUpUrl query param is required',
      sessionId,
    });
    window.close();
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

  // ─── Listen for postMessage from the GateGuard iframe ─────────────

  window.addEventListener('message', (event) => {
    // Only accept messages from the GateGuard embed iframe
    // The iframe origin is challenge.hcs-u7.org (or the configured domain)
    const data = event.data;

    if (!data || typeof data !== 'object') return;

    if (data.type === 'browserguard_stepup_result') {
      // Relay to background service worker
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
