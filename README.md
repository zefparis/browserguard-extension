# BrowserGuard Extension

Chrome extension (Manifest V3) for passive behavioral verification with cognitive step-up.

Part of the HCS-U7 ecosystem. Routes traffic through the Cloudflare Worker `hcs-u7-proxy` under `/hv/*`.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│  Chrome Extension (browserguard-extension)                              │
│                                                                         │
│  content-script.ts          background.ts (service worker)              │
│  ┌───────────────┐          ┌──────────────────────────────┐           │
│  │ Passive capture│  msg    │ Aggregate snapshots           │           │
│  │ keystroke/mouse│────────▶│ POST /hv/api/browserguard/    │           │
│  │ scroll         │         │   session-behavior-ping (≥5s) │           │
│  │ zero UI        │         │                              │           │
│  └───────────────┘          │ If step_up_required: true    │           │
│                             │   → chrome.windows.create    │           │
│                             │     step-up.html popup        │           │
│                             └──────────┬───────────────────┘           │
│                                        │ result                        │
│  step-up.html + step-up.ts             │                               │
│  ┌──────────────────────────┐          │                               │
│  │ Embeds GateGuard iframe  │◀─────────┘                               │
│  │ challenge.hcs-u7.org/    │                                          │
│  │   embed/?sessionId=...   │                                          │
│  │ Listens postMessage      │                                          │
│  │ Relays to background.ts  │──────────────────────────────────┐       │
│  │ Auto-closes              │                                  │       │
│  └──────────────────────────┘                                  │       │
└─────────────────────────────────────────────────────────────────┼───────┘
                                                                  │
                    ┌─────────────────────────────────────────────┘
                    ▼
┌──────────────────────────────────────────────────────────────────────┐
│  Cloudflare Worker (hcs-u7-proxy)                                     │
│  /hv/* → strips /hv, injects X-HCS-Worker-Auth, X-Behavioral-Risk-   │
│  Score, rate-limits (20 req/min SENSITIVE)                            │
└──────────────────────────┬───────────────────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│  hybrid-vector-api                                                    │
│  /api/browserguard/session-behavior-ping                              │
│  ├── workerAuthMiddleware (X-HCS-Worker-Auth)                         │
│  ├── behaviorScoring.ts (shared serializer v2)                        │
│  ├── trust_score_normalized computation                               │
│  ├── step_up_required: true if trust_score_normalized < 65            │
│  ├── step_up_url: "https://challenge.hcs-u7.org/embed/"               │
│  └── emitHcsIngest() fire-and-forget → hcs-u7-backend                 │
└──────────────────────────────────────────────────────────────────────┘
                           │
                           ▼
┌──────────────────────────────────────────────────────────────────────┐
│  gateguard-service                                                    │
│  /embed/ → isolated Stroop challenge page (iframe-embeddable)         │
│  /session/start (challengeCount:1, stroop_single)                     │
│  /verify → /session/finalize → decision GO/NO-GO/INSUFFICIENT         │
│  postMessage result to parent (chrome-extension://<id>)               │
└──────────────────────────────────────────────────────────────────────┘
```

## Flow

1. **Content script** captures keystroke intervals/hold/variance, mouse speed/curvature/pause, scroll speed/pause — zero visible UI. Flushes to service worker every 5s.

2. **Service worker** aggregates snapshots and POSTs to `/hv/api/browserguard/session-behavior-ping` every ≥5s (stays under the 20 req/min Worker rate limit).

3. **Backend** (hybrid-vector-api) scores the behavioral snapshot using the shared `behaviorScoring.ts` (same EMA, divergence, reference window as LiveGuard/PulseGuard). Computes `trust_score_normalized`. If `< 65` and reference window is established, responds with `step_up_required: true` + `step_up_url`.

4. **Service worker** opens `step-up.html` as a popup window (480×400, focused).

5. **step-up.html** embeds the GateGuard `/embed/` iframe with `callbackOrigin=chrome-extension://<id>`. The iframe runs a single Stroop challenge.

6. **GateGuard iframe** sends `postMessage({ type: 'browserguard_stepup_result', decision, score, confidence })` to step-up.html.

7. **step-up.ts** relays the result to the background service worker via `chrome.runtime.sendMessage`, then auto-closes the popup.

8. **Service worker** interprets the result:
   - `GO` → step-up succeeded
   - `INSUFFICIENT_CONFIDENCE` + `score >= 60` → step-up succeeded
   - `NO-GO` → step-up failed
   
   Notifies the backend, resumes behavioral beacons.

## Manifest Permissions

| Permission | Justification |
|-----------|---------------|
| `storage` | Persist session ID across service worker restarts (MV3 kills SWs) |
| `alarms` | Safety-net alarm that survives SW kills and wakes the SW to resume the 5s beacon cycle (see [Beacon scheduling](#beacon-scheduling-hybrid-setinterval--chromealarms)) |
| `host_permissions: https://api.hcs-u7.org/hv/*` | Beacon to backend through the Worker proxy |

No `tabs`, `history`, `cookies`, or `webRequest` permissions — minimal surface.

## Build

### Development (local testing)

```bash
npm install
npm run build    # tsc + esbuild + copy assets to dist/
```

Load `dist/` as an unpacked extension in `chrome://extensions` (developer mode).
The `dist/manifest.json` retains the `"key"` field for a stable extension ID
across reloads.

### Publication (Chrome Web Store)

```bash
npm run build:publish    # tsc + esbuild + strip "key" + zip
```

Produces:
- `dist-publish/` — unpacked extension without the `"key"` field
- `browserguard-vX.Y.Z.zip` — ready to upload to the Chrome Web Store

The `"key"` field is required for local development (stable extension ID)
but **rejected** by the Chrome Web Store upload validator. The publish build
strips it automatically.

**Difference:**

| | `npm run build` | `npm run build:publish` |
|---|---|---|
| Output | `dist/` | `dist-publish/` + `.zip` |
| `"key"` field | Present (stable dev ID) | Stripped (Web Store compliant) |
| Use case | `chrome://extensions` unpacked | Web Store upload |

## Configuration

The extension is configured via constants in `src/background.ts`:
- `BACKEND_URL` — Worker proxy URL (default: `https://api.hcs-u7.org/hv/api/browserguard/session-behavior-ping`)
- `STEP_UP_URL_BASE` — GateGuard embed URL (default: `https://challenge.hcs-u7.org/embed/`)
- `BEACON_INTERVAL_MS` — beacon frequency (default: 5000ms)

## Security Notes

- The extension does NOT carry `HV_API_KEY` — authentication relies on `X-HCS-Worker-Auth` injected by the Worker.
- `X-Source-App: 'browserguard'` is set for audit logging (not authorization).
- The step-up iframe is sandboxed (`allow-scripts allow-same-origin`).
- `callbackOrigin` is always `chrome-extension://<id>` — never `*`.
- The GateGuard embed validates `callbackOrigin` and refuses invalid origins.

## Beacon scheduling (hybrid: setInterval + chrome.alarms)

MV3 service workers are killed by Chrome after ~30s of idleness. When killed,
`setInterval` stops permanently and is not recreated until the SW restarts and
the lifecycle block runs again.

`chrome.alarms` survives SW kills and wakes the SW at the scheduled time, but
has a **minimum period of ~1 minute** in release builds (Chrome clamps
`periodInMinutes < 1` to 1). This is too coarse for the 5s beacon cadence.

**Solution: hybrid scheduling.**

| Mechanism | Period | Role |
|-----------|--------|------|
| `setInterval(sendBeacon, 5000)` | 5s | Fine cadence while SW is alive |
| `chrome.alarms` (`browserguard_beacon`) | 1 min | Safety net — wakes SW after kill, calls `sendBeacon` directly, and triggers lifecycle block which recreates the `setInterval` |

The alarm fires at most once per minute — much less frequent than the 5s
`setInterval` — so it does not duplicate beacons in practice. When both fire
close together, `sendBeacon`'s idempotency guards (skip if step-up in progress,
skip if session invalidated, skip if no snapshot) prevent double sends.

The alarm is **not cleared** on `beforeunload` (SW suspend) — it is designed to
survive and wake the SW. It is cleared only when the session is invalidated by
the backend or when the beacon is paused via the debug API.

## Related Repos

- **hybrid-vector-api** — backend route `/api/browserguard/session-behavior-ping`
- **hcs-u7-proxy** — Cloudflare Worker, routes `/hv/*` to backend
- **gateguard-service** — cognitive challenge service, `/embed/` page
- **hcs-u7-backend** — dashboard ingest (`hv_sessions` via `emitHcsIngest`)

## License

Patents Pending FR2514274 | FR2514546
© 2026 Benjamin BARRERE / IA SOLUTION
