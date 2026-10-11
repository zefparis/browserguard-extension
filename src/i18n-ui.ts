/**
 * BrowserGuard — DEV-ONLY dictionary (badge titles + popup labels).
 *
 * This module must NEVER be reachable from production code paths: it is
 * imported only by popup.ts (dist-dev only) and by background.ts code
 * inside `__BG_DEV__`-gated if-statements, so esbuild tree-shakes it out
 * of production bundles entirely. Keeping these strings out of i18n.ts
 * (which ships inside step-up.js in prod) is what makes that work.
 *
 * User-facing texts are LEGAL-REVIEW candidates (see cogsign-local
 * README — "relus par un juriste avant tout pilote").
 */

import { detectLang, type Lang } from './i18n';

const UI_STRINGS: Record<string, Record<Lang, string>> = {
  // ── Status titles (chrome.action.setTitle + popup status line) ──
  'status.no_key':            { fr: 'Inactif — protection non activée par votre organisation', en: 'Inactive — protection not enabled by your organization' },
  'status.server_backoff':    { fr: 'Erreur — serveur indisponible', en: 'Error — server unavailable' },
  'status.session_invalidated': { fr: 'Erreur — session fermée par le serveur', en: 'Error — session closed by the server' },
  'status.beacon_failures':   { fr: 'Erreur — connexion impossible', en: 'Error — cannot reach the server' },
  'status.stepup':            { fr: 'Vérification demandée — un test cognitif est en cours ou requis', en: 'Verification required — a cognitive check is in progress or required' },
  'status.connecting':        { fr: 'Connexion en cours…', en: 'Connecting…' },
  'status.active':            { fr: 'Actif — la vérification comportementale fonctionne', en: 'Active — behavioral verification is running' },
  'status.idle':              { fr: 'Actif, au repos', en: 'Active, idle' },

  // ── Popup ──
  'popup.title':           { fr: 'BrowserGuard', en: 'BrowserGuard' },
  'popup.status_label':    { fr: 'Statut', en: 'Status' },
  'popup.last_check':      { fr: 'Dernière vérification', en: 'Last verification' },
  'popup.last_check_none': { fr: 'Aucune', en: 'None' },
  'popup.last_check_pass': { fr: 'Validée', en: 'Passed' },
  'popup.last_check_fail': { fr: 'Non validée', en: 'Not passed' },
  'popup.never':           { fr: 'Jamais', en: 'Never' },
  'popup.collected_title': { fr: 'Ce qui est collecté', en: 'What is collected' },
  'popup.collected_items': {
    fr: 'Cadence et rythme de frappe (intervalles et durées — jamais les touches ni le texte saisi) · Mouvements, vitesses et pauses de la souris · Vitesses et pauses de défilement · Dimensions de la fenêtre d’affichage et type d’appareil · Version et empreinte d’intégrité de l’extension · Identifiants pseudonymes : identifiant d’installation (persistant) et identifiant de session (renouvelé régulièrement).',
    en: 'Typing cadence and rhythm (inter-key timing — never the keys or the text itself) · Mouse movements, speeds and pauses · Scroll speeds and pauses · Viewport size and device type · Extension version and integrity hash · Pseudonymous identifiers: install ID (persistent) and session ID (rotated regularly).',
  },
  'popup.collected_never': {
    fr: 'Jamais collectés : touches pressées, contenu saisi, URL ou titre des pages, contenu des pages, historique de navigation.',
    en: 'Never collected: keys pressed, typed content, page URLs or titles, page content, browsing history.',
  },
  'popup.privacy':   { fr: 'Politique de confidentialité', en: 'Privacy policy' },
  'popup.version':   { fr: 'Version', en: 'Version' },
  'popup.unavailable': { fr: 'Statut indisponible — le service worker ne répond pas', en: 'Status unavailable — the service worker is not responding' },
};

export function tUi(key: string, lang?: Lang): string {
  const entry = UI_STRINGS[key];
  if (!entry) return key;
  return entry[lang ?? detectLang()] ?? entry.en;
}
