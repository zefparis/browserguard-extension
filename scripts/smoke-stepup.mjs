#!/usr/bin/env node
/**
 * BrowserGuard — Smoke test E2E du flow step-up via le Cloudflare Worker.
 *
 * À lancer après chaque rotation de clés. Valide la chaîne complète :
 *
 *   GET  /hv/gateguard/health            → proofEnabled (secret présent côté gateguard)
 *   POST /hv/gateguard/session/start     → GATEGUARD_API_KEY injectée par le Worker
 *   POST /hv/gateguard/challenge + /verify ×5 → session GateGuard réelle (GO)
 *   POST /hv/gateguard/session/finalize  → proofToken HMAC émis
 *   POST /hv/api/browserguard/step-up-result → vérification du token par hv-api
 *
 * Aucun secret n'est requis côté client : sur /hv/gateguard/* le Worker écrase
 * X-API-Key avec env.GATEGUARD_API_KEY, et sur /hv/api/* il injecte
 * X-HCS-Worker-Auth. Le smoke teste donc précisément les secrets déployés.
 *
 * Config (variables d'environnement, valeurs par défaut = prod) :
 *   WORKER_BASE_URL   défaut https://api.hcs-u7.org
 *   GATEGUARD_BASE    défaut ${WORKER_BASE_URL}/hv/gateguard
 *   BG_BASE           défaut ${WORKER_BASE_URL}/hv/api/browserguard
 *   SMOKE_TENANT_ID   défaut 'browserguard-smoke'
 *   HTTP_TIMEOUT_MS   défaut 15000
 *   RETRY_DELAY_MS    délai avant le retry unique sur 5xx/timeout (défaut 5000)
 *
 * Sécurité : ne jamais afficher de clé ni de proofToken — le script ne
 * rapporte que leur présence/longueur.
 *
 * Exit code : 0 si toute la chaîne passe, 1 sinon.
 */

const WORKER_BASE_URL = (process.env.WORKER_BASE_URL || 'https://api.hcs-u7.org').replace(/\/$/, '');
const GATEGUARD_BASE = (process.env.GATEGUARD_BASE || `${WORKER_BASE_URL}/hv/gateguard`).replace(/\/$/, '');
const BG_BASE = (process.env.BG_BASE || `${WORKER_BASE_URL}/hv/api/browserguard`).replace(/\/$/, '');
const TENANT_ID = process.env.SMOKE_TENANT_ID || 'browserguard-smoke';
const HTTP_TIMEOUT_MS = Number(process.env.HTTP_TIMEOUT_MS) || 15_000;
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS) || 5_000;

// RTs humains plausibles autour de la médiane Stroop (600ms), répartis dans
// des buckets de 50ms distincts pour l'entropie cross-challenge (>= 1.0 bit).
const REACTION_TIMES = [640, 782, 551, 893, 677];

let failures = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function line(status, name, detail = '') {
  const tag = status === 'OK' ? 'OK ' : status === 'SKIP' ? 'SKIP' : 'KO ';
  console.log(`[${tag}] ${name}${detail ? ' — ' + detail : ''}`);
  if (status === 'KO') failures++;
}

function diag(msg) {
  console.log(`       ↳ ${msg}`);
}

/**
 * fetch JSON avec timeout. Une tentative + un retry unique si 5xx ou erreur
 * réseau/timeout (cold start Render). Retourne { status, ms, data } ou
 * { status: 0, ms, networkError }.
 */
async function callJson(method, url, body) {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const t0 = Date.now();
    try {
      const resp = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Source-App': 'browserguard' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      const ms = Date.now() - t0;
      let data = null;
      try { data = await resp.json(); } catch { /* body non-JSON */ }
      if (resp.status >= 500 && attempt === 1) {
        diag(`HTTP ${resp.status} — service injoignable ou en démarrage à froid, retry dans ${RETRY_DELAY_MS / 1000}s`);
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      return { status: resp.status, ms, data };
    } catch (err) {
      const ms = Date.now() - t0;
      if (attempt === 1) {
        diag(`${err.name === 'TimeoutError' || err.name === 'AbortError' ? 'timeout' : 'erreur réseau'} (${err.message}) — retry dans ${RETRY_DELAY_MS / 1000}s`);
        await sleep(RETRY_DELAY_MS);
        continue;
      }
      return { status: 0, ms, networkError: err.message };
    }
  }
}

async function main() {
  console.log(`Smoke step-up — worker=${WORKER_BASE_URL} tenant=${TENANT_ID}`);

  const userId = `browserguard_smoke-${Date.now()}`;
  const bgSessionId = userId.slice('browserguard_'.length);

  // ── 0. Health GateGuard via Worker (proofEnabled = secret proof présent) ──
  const health = await callJson('GET', `${GATEGUARD_BASE}/health`);
  if (health.status === 200 && health.data) {
    line('OK', 'gateguard /health', `HTTP 200 — ${health.ms}ms — proofEnabled=${health.data.proofEnabled}`);
    if (health.data.proofEnabled !== true) {
      diag('GATEGUARD_STEPUP_PROOF_SECRET absent côté gateguard-service — aucun proofToken ne sera émis');
    }
  } else {
    line('KO', 'gateguard /health', `HTTP ${health.status} — ${health.ms}ms${health.networkError ? ' — ' + health.networkError : ''}`);
    if (health.status === 0 || health.status >= 500) diag('service injoignable ou en démarrage à froid');
    return process.exit(1);
  }

  // ── 1. session/start — teste GATEGUARD_API_KEY injectée par le Worker ──
  const start = await callJson('POST', `${GATEGUARD_BASE}/session/start`, {
    userId,
    tenantId: TENANT_ID,
    challengeCount: REACTION_TIMES.length,
    challengeType: 'stroop_single',
  });
  if (start.status !== 200 || !start.data?.sessionId) {
    line('KO', 'gateguard session/start', `HTTP ${start.status} — ${start.ms}ms — ${JSON.stringify(start.data || {}).slice(0, 120)}`);
    if (start.status === 401 || start.status === 403) {
      diag('GATEGUARD_API_KEY du Worker désynchronisée avec gateguard-service');
      diag('Fix : cd hcs-u7-proxy && wrangler secret put GATEGUARD_API_KEY  (valeur = Render env de gateguard-service)');
    } else if (start.status === 429) {
      diag('rate limit sessions concurrentes par IP — attendre retryAfterMs et relancer');
    } else if (start.status === 0 || start.status >= 500) {
      diag('service injoignable ou en démarrage à froid');
    }
    return process.exit(1);
  }
  const sessionId = start.data.sessionId;
  line('OK', 'gateguard session/start', `HTTP 200 — ${start.ms}ms — sessionId=${sessionId.slice(0, 8)}…`);

  // ── 2. 5 challenges Stroop : /challenge puis /verify ──
  let challenge = start.data.firstChallenge;
  let verifyFailed = false;
  for (let i = 0; i < REACTION_TIMES.length; i++) {
    if (i > 0) {
      const next = await callJson('POST', `${GATEGUARD_BASE}/challenge`, { userId, tenantId: TENANT_ID, sessionId });
      if (next.status !== 200 || !next.data?.challengeId) {
        line('KO', `challenge #${i + 1}`, `HTTP ${next.status} — ${next.ms}ms`);
        if (next.status === 401 || next.status === 403) diag('GATEGUARD_API_KEY du Worker désynchronisée avec gateguard-service');
        verifyFailed = true;
        break;
      }
      challenge = next.data;
    }
    const answer = challenge?.stimulus?.displayColor;
    const verify = await callJson('POST', `${GATEGUARD_BASE}/verify`, {
      challengeId: challenge.challengeId,
      sessionId,
      response: { selectedColor: answer },
      reactionTimeMs: REACTION_TIMES[i],
    });
    if (verify.status !== 200 || verify.data?.correct !== true) {
      line('KO', `verify #${i + 1}`, `HTTP ${verify.status} — ${verify.ms}ms — ${JSON.stringify(verify.data || {}).slice(0, 120)}`);
      if (verify.status === 401 || verify.status === 403) diag('GATEGUARD_API_KEY du Worker désynchronisée avec gateguard-service');
      verifyFailed = true;
      break;
    }
    line('OK', `verify #${i + 1}`, `HTTP 200 — ${verify.ms}ms — correct`);
  }
  if (verifyFailed) return process.exit(1);

  // ── 3. session/finalize — décision + proofToken ──
  const fin = await callJson('POST', `${GATEGUARD_BASE}/session/finalize`, { sessionId });
  const decision = fin.data?.decision;
  const proofToken = fin.data?.proofToken;
  if (fin.status !== 200 || !decision) {
    line('KO', 'gateguard session/finalize', `HTTP ${fin.status} — ${fin.ms}ms`);
    if (fin.status === 401 || fin.status === 403) diag('GATEGUARD_API_KEY du Worker désynchronisée avec gateguard-service');
    return process.exit(1);
  }
  if (decision !== 'GO' || !proofToken) {
    line('KO', 'gateguard session/finalize', `HTTP 200 — ${fin.ms}ms — decision=${decision} proofToken=${proofToken ? 'présent' : 'ABSENT'}`);
    if (decision !== 'GO') {
      diag(`GateGuard n'a pas rendu GO (score=${fin.data?.score}, confiance=${fin.data?.confidence}) — chaîne de preuve non testable, relancer le smoke`);
    } else {
      diag('GO sans proofToken — GATEGUARD_STEPUP_PROOF_SECRET absent côté gateguard-service (Render env)');
    }
    return process.exit(1);
  }
  line('OK', 'gateguard session/finalize', `HTTP 200 — ${fin.ms}ms — decision=GO score=${fin.data.score} conf=${fin.data.confidence} proofToken présent (len=${proofToken.length})`);

  // ── 4. step-up-result sur hv-api — vérifie la signature HMAC ──
  const su = await callJson('POST', `${BG_BASE}/step-up-result`, {
    sessionId: bgSessionId,
    stepUpSuccess: true,
    decision: 'GO',
    score: fin.data.score,
    confidence: fin.data.confidence,
    proofToken,
  });
  if (su.status === 200 && su.data?.new_session_id) {
    line('OK', 'hv-api step-up-result', `HTTP 200 — ${su.ms}ms — session rotée`);
  } else {
    const code = su.data?.error || `HTTP ${su.status}`;
    line('KO', 'hv-api step-up-result', `HTTP ${su.status} — ${su.ms}ms — ${code}`);
    if (su.data?.error === 'PROOF_INVALID_SIGNATURE') {
      diag('GATEGUARD_STEPUP_PROOF_SECRET différent entre gateguard-service et hv-api');
    } else if (su.data?.error === 'PROOF_NOT_CONFIGURED') {
      diag('GATEGUARD_STEPUP_PROOF_SECRET absent côté hv-api (Render env)');
    } else if (su.data?.error === 'WORKER_AUTH_FAILED') {
      diag('HCS_WORKER_SHARED_SECRET désynchronisé entre Worker et hv-api');
    } else if (su.data?.error === 'WORKER_AUTH_NOT_CONFIGURED') {
      diag('HCS_WORKER_SHARED_SECRET absent côté hv-api (Render env)');
    } else if (su.status === 0 || su.status >= 500) {
      diag('service injoignable ou en démarrage à froid');
    }
    return process.exit(1);
  }

  console.log(`\n✔ Smoke step-up complet — chaîne Worker → gateguard → hv-api saine`);
  process.exit(0);
}

main().catch((err) => {
  console.error(`[KO ] erreur inattendue — ${err.message}`);
  process.exit(1);
});
