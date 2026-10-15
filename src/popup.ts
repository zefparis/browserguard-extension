/**
 * BrowserGuard — action popup (dist-dev builds only).
 *
 * Shows the extension status as full text (the badge alone is not
 * accessible — screen readers don't announce it). NO storage access,
 * NO fetch: the only input is the sanitized object returned by the
 * service worker for `browserguard_status_query`. The tenant key,
 * sessionId and installId never reach this page.
 *
 * @copyright (c) 2026 Benjamin BARRERE / IA SOLUTION
 * @license Patents Pending FR2514274 | FR2514546
 */

import { detectLang, type Lang } from './i18n';
import { tUi } from './i18n-ui';
import { buildProofUrl } from './proof-link';
import type { StatusResponse, StatusLevel } from './status';

declare const __BG_PRIVACY_URL__: string;
const PRIVACY_URL: string = typeof __BG_PRIVACY_URL__ === 'string' ? __BG_PRIVACY_URL__ : '';

const LEVEL_COLORS: Record<StatusLevel, string> = {
  inactive: '#64748b',
  error: '#dc2626',
  attention: '#d97706',
  connecting: '#64748b',
  active: '#16a34a',
  idle: '#64748b',
};

const lang: Lang = detectLang();

function el(id: string): HTMLElement {
  return document.getElementById(id)!;
}

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(lang === 'fr' ? 'fr-FR' : 'en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function render(resp: StatusResponse): void {
  el('status-dot').style.background = LEVEL_COLORS[resp.level] ?? '#64748b';
  el('status-text').textContent = tUi(`status.${resp.reasonCode}`, lang);

  let last: string;
  if (resp.lastStepUpAt === null) {
    last = tUi('popup.last_check_none', lang);
  } else {
    const verdict = resp.lastStepUpSuccess
      ? tUi('popup.last_check_pass', lang)
      : tUi('popup.last_check_fail', lang);
    last = `${fmtTime(resp.lastStepUpAt)} — ${verdict}`;
  }
  el('last-check').textContent = last;

  el('version-line').textContent = `${tUi('popup.version', lang)} ${resp.version}`;
  renderHistory(resp.decisionHistory ?? []);
}

// Local proof history: decisionId + outcome + timestamp only. Each row
// opens the public proof page in a new tab via chrome.tabs.create (no
// "tabs" permission required for create).
function renderHistory(entries: StatusResponse['decisionHistory']): void {
  const list = el('history-list');
  list.replaceChildren();
  const empty = !entries || entries.length === 0;
  el('history-empty').textContent = empty ? tUi('popup.history_empty', lang) : '';
  if (empty) return;
  for (const e of entries) {
    const url = buildProofUrl(e.decisionId);
    if (!url) continue;
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    const time = document.createElement('span');
    time.textContent = fmtTime(e.at);
    const outcome = document.createElement('span');
    outcome.className = 'outcome';
    outcome.textContent = e.outcome;
    btn.append(time, outcome);
    btn.addEventListener('click', () => {
      try { chrome.tabs.create({ url }); } catch { /* best effort */ }
    });
    li.append(btn);
    list.append(li);
  }
}

function renderFallback(): void {
  el('status-text').textContent = tUi('popup.unavailable', lang);
  el('status-dot').style.background = '#64748b';
}

function query(): void {
  try {
    chrome.runtime.sendMessage({ type: 'browserguard_status_query' }, (resp: StatusResponse | undefined) => {
      if (chrome.runtime.lastError || !resp) { renderFallback(); return; }
      render(resp);
    });
  } catch {
    renderFallback();
  }
}

function init(): void {
  document.documentElement.lang = lang;
  el('status-label').textContent = tUi('popup.status_label', lang);
  el('last-check-label').textContent = tUi('popup.last_check', lang);
  el('history-title').textContent = tUi('popup.history_title', lang);
  el('collected-title').textContent = tUi('popup.collected_title', lang);
  el('collected-items').textContent = tUi('popup.collected_items', lang);
  el('collected-never').textContent = tUi('popup.collected_never', lang);

  // Privacy link only when a URL was configured at build time —
  // never render a broken link.
  if (PRIVACY_URL) {
    const link = el('privacy-link') as HTMLAnchorElement;
    link.textContent = tUi('popup.privacy', lang);
    link.href = PRIVACY_URL;
    link.hidden = false;
  }

  query();
  window.addEventListener('focus', query);
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
}
