/**
 * BrowserGuard — minimal FR/EN dictionary for the STEP-UP page.
 *
 * Only stepup.* keys live here: this module is bundled into step-up.js
 * which ships in PRODUCTION. Dev-only strings (badge titles, popup
 * labels) live in i18n-ui.ts so they never reach the prod bundle.
 *
 * Deliberately a plain dictionary rather than chrome.i18n/_locales:
 * the surface is a handful of keys and _locales would require
 * default_locale in the manifest plus per-file messages.json —
 * heavier than the payoff at this size. Migrating to _locales later
 * only requires moving STRINGS, not changing call sites.
 *
 * User-facing texts are LEGAL-REVIEW candidates (see cogsign-local
 * README — "relus par un juriste avant tout pilote").
 */

export type Lang = 'fr' | 'en';

const STRINGS: Record<string, Record<Lang, string>> = {
  // ── Step-up page ──
  'stepup.intro':    { fr: 'Vérification de présence humaine demandée par votre organisation', en: 'Human-presence verification requested by your organization' },
  'stepup.loading':  { fr: 'Initialisation…', en: 'Loading…' },
  'stepup.success':  { fr: 'Vérification validée', en: 'Verification passed' },
  'stepup.failure':  { fr: 'Vérification non validée', en: 'Verification not passed' },
  'stepup.pending':  { fr: 'Résultat en cours d\'envoi, vous pouvez fermer cette fenêtre', en: 'Result is being submitted — you may close this window' },
  'stepup.not_recorded': { fr: 'Résultat non enregistré — contactez votre administrateur si le problème persiste', en: 'Result not recorded — contact your administrator if the problem persists' },
  'stepup.no_direct': { fr: 'Cette page ne peut pas être ouverte directement. Elle est appelée automatiquement par BrowserGuard lors d\'un step-up.', en: 'This page cannot be opened directly. It is launched automatically by BrowserGuard during a step-up.' },
  'stepup.iframe_failed': { fr: 'Impossible de charger le test.', en: 'Unable to load the challenge.' },
  'stepup.iframe_timeout': { fr: 'Le test n\'a pas répondu dans les 10 s.', en: 'The challenge did not respond within 10 s.' },
  'stepup.error':    { fr: 'Erreur : ', en: 'Error: ' },
  'stepup.proof_link': { fr: 'Voir la preuve de cette décision', en: 'View the proof of this decision' },
};

export function detectLang(): Lang {
  let raw = '';
  try {
    // Chrome pages/SW: getUILanguage is the user-visible UI language.
    const g = (globalThis as any).chrome?.i18n?.getUILanguage?.();
    raw = typeof g === 'string' && g ? g : (globalThis.navigator?.language ?? '');
  } catch {
    raw = globalThis.navigator?.language ?? '';
  }
  return raw.toLowerCase().startsWith('fr') ? 'fr' : 'en';
}

export function t(key: string, lang?: Lang): string {
  const entry = STRINGS[key];
  if (!entry) return key;
  return entry[lang ?? detectLang()] ?? entry.en;
}
