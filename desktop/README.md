# Desktop Realtime Translation Example

A standalone Electron app that connects directly to the Tellus staging Realtime Speech server. Microphone
capture, Silero VAD, and Opus encoding run in the native Tellus audio engine
([`@tellus-ai/audio-sdk`](https://github.com/tellus-ai/tellus-audio-sdk)) inside the Electron main process.
The React screen started as a copy of the [web example](../web/README.md); nothing is imported from `web/`.

See the root [`README.md`](../README.md#api-contract-snapshot-2026-09-10) for the Swagger snapshot of the
REST and WebSocket contracts used by this example.

## Run

```bash
cp .env.example .env   # set API_KEY and TELLUS_AUDIO_ENGINE_TOKEN
npm install
npm run dev
```

You can also use the development script, which checks `.env` first.

```bash
./dev.sh
```

`npm install` downloads the native engine from a private GitHub release, so it needs
`TELLUS_AUDIO_ENGINE_TOKEN` (a Tellus-issued GitHub token) in `.env` or in the shell environment. The token
is used only at install time. npm prepares the SDK git dependency in a temporary clone where its installer
cannot see this project's `.env`, so `.npmrc` loads the token into the environment first, the same way
Tellus-client-desktop does.

`npm run dev` starts the Vite dev server and opens it inside Electron. Renderer changes hot-reload;
restart `npm run dev` after changing `electron/` or `.env`. `npm start` runs the last `npm run build`
output without the dev server, the same way a packaged app does.

On macOS the app asks for microphone access the first time you press **Start**.

## Package

```bash
npm run pack   # unsigned app in release/<platform>/ for local testing
npm run dist   # installers for the current platform
```

`npm run dist` signs with a code signing identity from your keychain when one is available. Notarization is
not configured. The engine's native addon, ONNX Runtime library, and models are unpacked from `app.asar`
(`asarUnpack`) because native code cannot read files inside the archive.

The build writes `dist/runtime.env` with only `REALTIME_SPEECH_HTTP_URL`, `REALTIME_SPEECH_WS_URL`, and
`API_KEY`, and the packaged app reads that file. `TELLUS_AUDIO_ENGINE_TOKEN` is never bundled. `API_KEY` is,
so anyone with the app can extract it, the same way the web build exposes the token in its bundle. Use a
short-lived, restricted access token and do not distribute builds that contain your own token.

## Architecture

The main process owns the whole session; the renderer only draws it.

| Process | Responsibility |
| --- | --- |
| Main | Audio engine capture, REST calls with `API_KEY`, Result and Audio WebSockets, reconnects, transcript state |
| Renderer | Language and VAD selection, Start/Pause/Resume/Stop, rendering the session snapshot pushed over IPC |

- **Audio engine.** `AudioEngine.init()` runs at app start and preloads the Silero model. Each session
  creates a capture with 16 kHz, 20 ms Opus frames at 64 kbps and turns the engine VAD gate on or off with
  `setVadEnabled()`. Denoise is off, matching the Tellus desktop app default.
- **VAD boundaries.** The engine marks gate transitions on audio chunks (`gateEvent`). The session sends the
  matching `audio.status` event before the frame it applies to, with `boundary_sample` counted from the start
  of the current Audio WebSocket. A boundary that is open when the session pauses or stops is closed first,
  and speech that is still in progress after a resume or reconnect re-opens it.
- **No Origin header.** WebSockets and REST requests come from the main process, like other native
  clients, so the renderer origin (`tellus-translate://app`) never reaches the server and does not need to
  be on its allowlist.
- **Session survives renderer reloads.** Reloading the window reattaches to the running session. Quitting
  the app stops the session and ends the conversation first.

## Environment

| Variable | Default | Notes |
| --- | --- | --- |
| `REALTIME_SPEECH_HTTP_URL` | `https://stgrtsapi.tellus.ai.kr` | `http:` is allowed only for localhost |
| `REALTIME_SPEECH_WS_URL` | `wss://stgrtsapi.tellus.ai.kr` | `ws:` is allowed only for localhost |
| `API_KEY` | | OAuth access token sent as `Authorization: Bearer <token>` |
| `TELLUS_AUDIO_ENGINE_TOKEN` | | Install time only: downloads the private native engine |

During development the main process reads `.env` next to `package.json`. Variables already set in the
process environment take precedence. Vite does not load `.env` for the renderer (`envDir: false`).

## Security Defaults

- `contextIsolation`, `sandbox`, and no `nodeIntegration`. The preload exposes only `window.tellusDesktop`.
- IPC handlers accept calls only from the main frame of the trusted renderer origin and validate every argument.
- The renderer has no permissions (the microphone is captured natively) and its CSP allows no network access.
- Navigation away from the renderer and `window.open` are blocked.

## Layout

| Path | Role |
| --- | --- |
| `electron/main.ts` | App lifecycle, window, and wiring |
| `electron/preload.ts` | `window.tellusDesktop` bridge |
| `electron/audio/audioEngine.ts` | The only module that imports `@tellus-ai/audio-sdk` |
| `electron/realtime/RealtimeTranslationSession.ts` | Session lifecycle, WebSockets, `audio.status`, reconnects |
| `electron/realtime/VADAudioStatus.ts` | `audio.status` message builder |
| `electron/realtimeApi.ts` | REST client with the bearer token |
| `electron/realtimeIpc.ts` | IPC handlers and input validation |
| `electron/rendererProtocol.ts` | Serves the packaged renderer from `tellus-translate://app` |
| `electron/security.ts` | Trusted origin, permissions, CSP, navigation lock |
| `electron/shared/` | Types shared by main, preload, and renderer |
| `src/` | Renderer (React UI) |

## Verification

```bash
npm run typecheck
npm test
npm run build
```

## Live Development Server Smoke Test

Like the web smoke test, this uses `API_KEY` from `.env` only as a Bearer token and never prints it. It
creates a Conversation, connects both WebSockets without an Origin header as the app does, sends PCM16 audio,
and ends the Conversation in `finally`. Set `SMOKE_ORIGIN` to check how the server treats a browser origin.

```bash
npm run test:live
```
