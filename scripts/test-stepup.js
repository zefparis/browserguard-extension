// ═══════════════════════════════════════════════════════════════════
// BrowserGuard — Test step-up autonome
// À coller dans la console du SERVICE WORKER (pas la popup) :
//   chrome://extensions → BrowserGuard → "Service worker" → Console
// ═══════════════════════════════════════════════════════════════════
(async () => {
  const log = (...a) => console.log(`[${new Date().toISOString()}] [STEPUP-TEST]`, ...a);
  const bg = globalThis.browserguard;
  if (!bg?.test) { console.error('[STEPUP-TEST] browserguard.test not found — reload the extension'); return; }

  // 1. Reset propre
  log('=== RESET ===');
  bg.test.resetStepUp();
  bg.test.pauseAutoBeacon();
  log('Auto beacon paused, stepUp reset');
  log('sessionId:', bg.test.state().sessionId);

  // 2. Snapshot "humain normal" — référence
  log('=== PHASE 1: référence humaine (5 pings, ~25s) ===');
  const humanSnap = {
    keystrokeIntervals: [180, 175, 185, 190, 170, 182, 178, 188, 172, 184, 176, 186, 174, 182, 180],
    keystrokeHolds: [90, 88, 92, 91, 89, 90, 93, 87, 91, 90, 89, 92, 90, 88, 91],
    keystrokeCount: 15,
    mouseSpeeds: [1.2, 1.1, 1.3, 1.0, 1.4, 1.2, 1.1, 1.3, 1.2, 1.1, 1.3, 1.2, 1.1, 1.4, 1.2, 1.3, 1.1, 1.2, 1.0, 1.3],
    mouseCurvatures: [0.3, 0.28, 0.32, 0.29, 0.31, 0.30, 0.27, 0.33, 0.29, 0.31, 0.30, 0.28, 0.32, 0.29, 0.30, 0.31, 0.28, 0.30, 0.29, 0.31],
    mousePauseCount: 3, mouseEventCount: 200,
    scrollSpeeds: [3, 2.8, 3.2, 3.1, 2.9, 3.0, 3.3, 2.7, 3.1, 3.0],
    scrollPauseCount: 2, scrollEventCount: 100,
    totalEvents: 315,
    timestamp: new Date().toISOString(),
    viewportWidth: 1920, viewportHeight: 1080, pixelRatio: 1,
  };

  for (let i = 1; i <= 5; i++) {
    bg.test.setSnapshot(humanSnap);
    log(`Ping ${i}/5 (référence)...`);
    await bg.test.triggerBeacon();
    log(`  state:`, bg.test.state());
    if (i < 5) { log('  attente 5s...'); await new Promise(r => setTimeout(r, 5000)); }
  }

  // 3. Snapshot "bot" — divergence massive
  log('=== PHASE 2: pic de divergence bot (snapshot robotique) ===');
  const botSnap = {
    keystrokeIntervals: [100, 100, 100, 100, 100, 100, 100, 100, 100, 100],
    keystrokeHolds: [50, 50, 50, 50, 50, 50, 50, 50, 50, 50],
    keystrokeCount: 10,
    mouseSpeeds: [5.0, 5.0, 5.0, 5.0, 5.0, 5.0, 5.0, 5.0, 5.0, 5.0],
    mouseCurvatures: [0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0, 0.0],
    mousePauseCount: 0, mouseEventCount: 500,
    scrollSpeeds: [10, 10, 10, 10, 10],
    scrollPauseCount: 0, scrollEventCount: 300,
    totalEvents: 810,
    timestamp: new Date().toISOString(),
    viewportWidth: 1920, viewportHeight: 1080, pixelRatio: 1,
  };

  log('Envoi du snapshot bot...');
  bg.test.setSnapshot(botSnap);
  log('Déclenchement du beacon (devrait déclencher step_up_required)...');
  await bg.test.triggerBeacon();
  log('State après beacon bot:', bg.test.state());

  // 4. Attendre l'ouverture de la popup (max 15s)
  log('=== PHASE 3: attente ouverture popup (max 15s) ===');
  const startWait = Date.now();
  while (Date.now() - startWait < 15000) {
    const s = bg.test.state();
    if (s.stepUpInProgress) {
      log(`✓ Popup ouverte à ${Date.now() - startWait}ms, windowId=${s.stepUpWindowId}`);
      log('Vérifie la fenêtre popup — le challenge Stroop doit s\'afficher dans l\'iframe.');
      log('Si tu vois une icône "image cassée", note l\'URL de l\'iframe dans la popup.');
      break;
    }
    await new Promise(r => setTimeout(r, 500));
  }

  const finalState = bg.test.state();
  if (!finalState.stepUpInProgress) {
    log('✗ Aucune popup ouverte après 15s — step_up_required n\'a pas été déclenché');
    log('  → Le backend n\'a probablement pas encore établi la fenêtre de référence');
    log('  → ou trust_score_normalized est resté >= 65');
    log('  → Vérifie les logs Render pour refWindow et trust_score');
  }

  log('=== RÉSUMÉ FINAL ===');
  log('sessionId:', finalState.sessionId);
  log('stepUpInProgress:', finalState.stepUpInProgress);
  log('stepUpWindowId:', finalState.stepUpWindowId);
  log('autoBeaconPaused:', finalState.autoBeaconPaused);
  log('');
  log('Pour reprendre le timer auto: browserguard.test.resumeAutoBeacon()');
  log('Pour forcer-reset: browserguard.test.resetStepUp()');
})();
