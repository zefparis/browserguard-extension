/**
 * BrowserGuard — options page (all builds).
 *
 * Lets a single non-enterprise owner paste the tenant ingest key.
 * The key goes into chrome.storage.local ONLY — never synced, never
 * logged, never sent anywhere except as the X-BrowserGuard-Key header
 * by the service worker. The service worker's storage.onChanged
 * listener picks the change up automatically.
 *
 * @copyright (c) 2026 Benjamin BARRERE / IA SOLUTION
 * @license Patents Pending FR2514274 | FR2514546
 */

import { detectLang, type Lang } from './i18n';
import { buildProofUrl, readDecisionHistory } from './proof-link';

const FIELD = 'browserguard_ingestKey';
const MIN_LEN = 32;

const STRINGS: Record<string, Record<Lang, string>> = {
  intro:    { fr: "Clé d'ingestion fournie par votre organisation. En l'absence de clé, l'extension ne collecte ni n'envoie rien.",
              en: "Ingest key provided by your organization. Without a key, the extension collects and sends nothing." },
  keylabel: { fr: "Clé d'ingestion", en: 'Ingest key' },
  save:     { fr: 'Enregistrer', en: 'Save' },
  clear:    { fr: 'Effacer', en: 'Clear' },
  saved:    { fr: 'Clé enregistrée.', en: 'Key saved.' },
  cleared:  { fr: 'Clé effacée.', en: 'Key cleared.' },
  tooShort: { fr: 'Clé trop courte (32 caractères minimum).', en: 'Key too short (32 characters minimum).' },
  note:     { fr: 'La clé reste sur cet appareil (stockage local, jamais synchronisé).',
              en: 'The key stays on this device (local storage, never synced).' },
  history:      { fr: 'Preuves de décisions récentes', en: 'Recent decision proofs' },
  historyEmpty: { fr: 'Aucune décision enregistrée.', en: 'No recorded decision.' },
};

const lang: Lang = detectLang();
const s = (k: keyof typeof STRINGS): string => STRINGS[k][lang];

const keyInput = document.getElementById('key') as HTMLInputElement;
const msg = document.getElementById('msg') as HTMLDivElement;

function show(text: string, ok: boolean): void {
  msg.textContent = text;
  msg.className = ok ? 'ok' : 'err';
}

document.getElementById('intro')!.textContent = s('intro');
document.getElementById('keylabel')!.textContent = s('keylabel');
document.getElementById('save')!.textContent = s('save');
document.getElementById('clear')!.textContent = s('clear');
document.getElementById('note')!.textContent = s('note');
document.documentElement.lang = lang;

document.getElementById('save')!.addEventListener('click', () => {
  const v = keyInput.value.trim();
  if (v.length < MIN_LEN) { show(s('tooShort'), false); return; }
  chrome.storage.local.set({ [FIELD]: v }, () => { show(s('saved'), true); keyInput.value = ''; });
});

document.getElementById('clear')!.addEventListener('click', () => {
  chrome.storage.local.remove(FIELD, () => { show(s('cleared'), true); });
});

// ─── Decision proof history ─────────────────────────────────────────
// Local history written by the service worker after each finalized
// step-up (decisionId + outcome + timestamp only). Each row opens the
// public proof page in a new tab via chrome.tabs.create.
document.getElementById('history-title')!.textContent = s('history');

function fmtTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(lang === 'fr' ? 'fr-FR' : 'en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function renderHistory(): void {
  void readDecisionHistory().then((entries) => {
    const list = document.getElementById('history-list')!;
    list.replaceChildren();
    const empty = entries.length === 0;
    document.getElementById('history-empty')!.textContent = empty ? s('historyEmpty') : '';
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
  });
}

renderHistory();
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === 'local') renderHistory();
});
