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
