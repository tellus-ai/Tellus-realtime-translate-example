# Desktop Realtime Translation Example

A standalone Electron app that connects directly to the Tellus staging Realtime Speech server. Microphone
capture, Silero VAD, and Opus encoding run in the native Tellus audio engine
([`@tellus-ai/audio-sdk`](https://github.com/tellus-ai/tellus-audio-sdk)) inside the Electron main process.
The React screen started as a copy of the [web example](../web/README.md); nothing is imported from `web/`.

See the root [`README.md`](../README.md#api-contract) for the Swagger snapshot of the
REST and WebSocket contracts used by this example.

## Run

Use Node.js 24. Install with the setup command before running the app:

```bash
cp .env.example .env   # set TELLUS_AUDIO_ENGINE_TOKEN (installation) and API_KEY (runtime login)
npm run setup
npm run dev
```

You can also use the development script, which checks `.env` first.

```bash
./dev.sh
```

`npm run setup` installs SDK **0.2.2** from the GitHub `v0.2.2` tag, with the exact commit recorded
in `package-lock.json`. The SDK installer uses the existing customer installation token to request
file-specific download tokens for native engine **0.3.1** and its checksum from
`TELLUS_AUDIO_DOWNLOAD_BASE_URL` (staging by default), then
downloads the engine files from `https://download.tellus.ai.kr` and verifies SHA-256. Login and download
tokens are kept out of package URLs, the lockfile, and logs. A CDN `401` gets one fresh grant and one retry.

The token API must be deployed on the selected Realtime Speech server. Its environment prefix must
contain the native engine archive for your platform and its `.sha256` file.
For staging this is `stg/audio/engine/v0.3.1/`. A missing API returns
`404`; a missing artifact or invalid installation token must be resolved before setup can finish.

`TELLUS_AUDIO_ENGINE_TOKEN` is the existing Tellus-issued customer installation token. Installation
does not use `API_KEY` or require an app login. `API_KEY` remains the login access token for REST calls
and engine execution approval at runtime. Installation and execution token renewal are separate.
Setup loads `.env` and passes both the engine token and download base URL to npm and its child
processes. This also covers the temporary Git clone where npm prepares the SDK. Setup runs `npm ci`
against the committed lockfile. A direct `npm install` or `npm ci` requires exporting both
`TELLUS_AUDIO_ENGINE_TOKEN` and `TELLUS_AUDIO_DOWNLOAD_BASE_URL` in the shell first.

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
| Main | Audio engine capture, REST calls with `API_KEY`, Result and Audio WebSockets (`ws`), reconnects, transcript state |
| Renderer | Language and VAD selection, Start/Pause/Resume/Stop, rendering the session snapshot pushed over IPC |

- **Audio engine.** `AudioEngine.init()` runs at app start and preloads the Silero model. Each session
  creates a capture with 16 kHz, 20 ms Opus frames at 64 kbps and turns the engine VAD gate on or off with
  `setVadEnabled()`. Denoise is off, matching the Tellus desktop app default.
- **Execution authorization.** Before capture starts, `attachEngineAuthorization()` sends
  `audio.authenticate` on the Audio WebSocket and waits for the native engine to accept the signed
  permit. It sends `engine.renew` at most eight minutes apart, including while paused. Closing the
  Audio WebSocket invalidates permission and stops capture; its reconnect obtains a new permit before
  capture starts again. A reconnect of only the Result WebSocket leaves the permit and capture alone.
  Terminal authorization denial stops the session. See
  [Native engine authorization on `/audio`](#native-engine-authorization-on-audio).
- **Login credentials.** Each REST call and engine authorization request rereads `API_KEY` from the
  environment/runtime file. Engine permit renewal does not refresh the login JWT itself. Supply a valid
  login token; a production integration should obtain refreshed credentials from its login service.
- **VAD boundaries.** The engine marks gate transitions on audio chunks (`gateEvent`). The session sends the
  matching `audio.status` event before the frame it applies to, with `boundary_sample` counted from the start
  of the current Audio WebSocket. A boundary that is open when the session pauses or stops is closed first,
  and speech that is still in progress after a resume or reconnect re-opens it.
- **No Origin header.** WebSockets and REST requests come from the main process, like other native
  clients, so the renderer origin (`tellus-translate://app`) never reaches the server and does not need to
  be on its allowlist. The WebSockets are opened with the `ws` package, which sends no Origin header
  unless one is set; see [WebSockets in the main process](#websockets-in-the-main-process).
- **Session survives renderer reloads.** Reloading the window reattaches to the running session. Quitting
  the app stops the session and ends the conversation first. It does not wait for the last results, and
  it waits at most 3 seconds for `POST /end`, also for one that a failed session is still sending.

## Error Handling and Reconnects

The session follows
[Close codes and recommended client behavior](../README.md#close-codes-and-recommended-client-behavior),
[Reconnecting after a disconnect](../README.md#reconnecting-after-a-disconnect), and
[Ending a Conversation](../README.md#ending-a-conversation) in the root README.

| Situation | What the example does |
| --- | --- |
| `system.error` on either socket | Keeps it as that socket's last error. Nothing is shown until the socket closes. |
| `conversation.ended`, close `1000`, or `1008` with `conversation_ended` or `conversation_not_found` | Shows the Conversation as `ended` and stops. No reconnect and no `POST /end`. |
| `1008` with `audio_connection_replaced` | Stops with an error and leaves the Conversation open for the other device or tab. |
| Any other `1008` | Stops with the server message and calls `POST /end`. The native authorization reasons that differ are listed [below](#native-engine-authorization-on-audio). |
| `1012` | Reopens the socket after a random 0.5–2 seconds, then backs off. |
| Any other close code, including `1006`, `1011`, and `1013` | Reopens the socket after 1, 2, 5, 10, then every 30 seconds, or after `retry_after_ms` when that is longer. A socket that closes while a reconnect is already waiting is reopened by that reconnect. |
| A socket closes, or is not usable in time, while starting (until both sockets are open and the engine is authorized, that is, before the status is `recording`) | The start fails. Nothing is reconnected. Result has 10 seconds to send `participants.snapshot`. `/audio` has 10 seconds to open, and the engine authorization then has its own 10 seconds. |
| Only the Result WebSocket closed | Capture, the engine authorization, and `/audio` continue. Only Result is reopened. |
| `/audio` closed | Disposes the engine authorization, which stops native capture, and shows `reconnecting`. The new socket is authorized first; then capture starts again and the sample cursor restarts at 0. The example sends an `audio.status` when the socket is authorized, which the server may ignore because no audio has arrived yet; VAD gate events follow with the audio frames. A session that was paused stays paused. |
| Both sockets closed | Opens Result first and `/audio` after `participants.snapshot`. |
| A reconnect attempt is not usable in time, or closes again | Moves to the next backoff step. The steps start over after both sockets stayed open for 30 seconds. |
| Result reconnected | Shows the results that arrive from then on. Results sent while the Result WebSocket was closed are not recovered. |
| Stop | Sends `speech_gate_closed` (if the gate is open) and `idle`, waits up to 2 seconds for the last finals, closes `/audio`, calls `POST /end`, and keeps Result open until `conversation.ended` or for 5 more seconds. Quitting the app skips both waits. |
| REST `503` | Retries after 1, 2, and 5 seconds. A request that gets no response, which includes the 15-second request timeout, is retried only for `POST /end`. `POST /end` treats `410` and `404` as ended. When every retry fails, the example gives up; if the request was `POST /end`, the Conversation stays open until its state expires 24 hours after creation. |

A reconnect shows only in the status (`reconnecting` while `/audio` is down) and in the connection state of
each socket. The close code and reason are not shown. `error` holds the message that stopped the session; a
malformed message on the Result WebSocket also sets it, and the session continues.

Source files:

- `electron/realtime/closePolicy.ts`: what each close means, and the backoff steps.
- `electron/realtime/RealtimeTranslationSession.ts`: sockets, the engine authorization, reconnects, and
  the Stop sequence.
- `electron/realtime/nodeWebSocket.ts`: opens the WebSockets with `ws`.
- `electron/realtime/resultParser.ts`: `system.error` and `participants.snapshot`.
- `electron/realtime/transcriptReducer.ts`: `awaitsFinal` tells which rows Stop still waits for.
- `electron/realtimeApi.ts`: `POST /end` statuses and `503` retries.

Not implemented:

- Reconnecting when no result arrives for 20 seconds while the speaker is talking.
- Watching `bufferedAmount` on `/audio`.
- Reconnecting `/audio` after 10 minutes without audio.
- Filling in finals missed while the Result WebSocket was closed, with `GET /conversations/{id}/messages`.
  [Reconnecting after a disconnect](../README.md#reconnecting-after-a-disconnect) describes how.
- Reconnecting at once when the network comes back. The main process has no browser `online` event, so a
  reconnect that is waiting keeps its backoff delay.

### WebSockets in the main process

The main process opens both WebSockets with the [`ws`](https://github.com/websockets/ws) package instead
of the `WebSocket` built into Node.js and Electron. Before an error close the server sends a compressed
`system.error` and the close frame, and ends the connection at once. The built-in client reports that as
`1006` with no message and no reason (observed with Node.js 22.19 and Electron 44.5.1), so every error
close looked like a network drop and the app kept reconnecting to Conversations that had ended. `ws`
reports the message, the close code, and the reason.

`ws` is a runtime dependency, so it is packaged with the app. `electron/realtime/nodeWebSocket.ts` adds an
`error` listener to every socket: in `ws` an `error` event without a listener is an uncaught exception,
and the session detaches its handlers before it closes a socket.

### Native engine authorization on `/audio`

`audio.authenticate` and `engine.renew` add these close reasons to `/audio`. They arrive like the others:
in `data.reason` of a `system.error` and as the reason of the close that follows.

| Reason | Code | Meaning | What the example does |
| --- | --- | --- | --- |
| `engine_conversation_inactive` | `1008` | The Conversation has ended or does not exist. | Shows the Conversation as `ended` and stops. No `POST /end`. |
| `engine_connection_superseded` | `1008` | A newer `/audio` connection replaced this socket. | Same as `audio_connection_replaced`: stops with an error and leaves the Conversation open. |
| `engine_authorization_expired` | `1008` | The permit expired without a renewal. | Reopens `/audio` with backoff, because the new socket gets a new permit. This is the only `1008` that is reconnected. |
| `engine_authentication_failed` | `1008` | The login token is invalid or expired. | Stops with the server message and calls `POST /end`. |
| `engine_access_denied`, `engine_authentication_invalid`, `engine_authentication_required`, `engine_request_replayed` | `1008` | No permission, or an invalid request. | Stops with the server message and calls `POST /end`. |
| `engine_authentication_unavailable`, `engine_authorization_unavailable`, `engine_authorization_unconfigured` | `1013` | A temporary failure, or the server is not configured for engine authorization. | Reopens `/audio` with backoff. |

A renewal that fails temporarily does not close the socket. The server answers `engine.denied` with
`retryable: true`, and the authorization module asks again.

`attachEngineAuthorization()` gives the socket up as soon as it receives a `system.error` and reports
`engine_authorization_server_error`, whatever the error was. It reports
`engine_authorization_connection_closed` or `engine_authorization_connection_failed` when it sees the
close or a connection error itself. The session does not treat these three as failures:

- It attaches its own handlers before the authorization module, keeps the `system.error`, and waits for
  the close. The rules above are applied to that close, so a `1013` reopens `/audio` instead of ending the
  session.
- Capture has already stopped by then, because the module invalidated the permit. Pause and Resume do
  nothing until the close has been handled.
- If no close arrives within 10 seconds, the socket is handled like a `1006`.

Two errors of the module close `/audio` and reconnect it like a `1006`, because a new socket is
authorized from the start: `engine_authorization_timeout` (no answer to a request within 10 seconds) and
`engine_authorization_expired` (the module found that the permit ran out before a renewal succeeded).
The second one is the same situation as the server's `1008` `engine_authorization_expired` above, and
either can arrive first. If the login token itself has expired, the server refuses the new socket with
`1008` `engine_authentication_failed`, which stops the session.

Any other error from the module, such as a final `engine.denied` (`engine_access_denied`) or
`engine_authorization_response_invalid`, stops the session and calls `POST /end`.

## Environment

| Variable | Default | Notes |
| --- | --- | --- |
| `REALTIME_SPEECH_HTTP_URL` | `https://stgrtsapi.tellus.ai.kr` | `http:` is allowed only for localhost |
| `REALTIME_SPEECH_WS_URL` | `wss://stgrtsapi.tellus.ai.kr` | `ws:` is allowed only for localhost |
| `API_KEY` | | OAuth access token sent as `Authorization: Bearer <token>` |
| `TELLUS_AUDIO_DOWNLOAD_BASE_URL` | staging HTTP URL | Realtime Speech artifact token API for native engine downloads |
| `TELLUS_AUDIO_ENGINE_TOKEN` | | Existing Tellus-issued customer installation token; installation only |

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
| `electron/realtime/RealtimeTranslationSession.ts` | Session lifecycle, WebSockets, engine authorization, `audio.status`, reconnects |
| `electron/realtime/closePolicy.ts` | What each WebSocket close means, and the backoff steps |
| `electron/realtime/nodeWebSocket.ts` | Opens the WebSockets with the `ws` package |
| `electron/realtime/VADAudioStatus.ts` | `audio.status` message builder |
| `electron/realtimeApi.ts` | REST client with the bearer token and `503` retries |
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

현재 개발 후보는 sibling `../../tellus-audio-sdk`를 사용한다. SDK의 `vendor/darwin-universal`에
같은 엔진 후보의 universal NAPI와 ORT/models를 준비한 뒤 `npm ci --ignore-scripts`로 설치한다.
공개 테스트 서명 키를 신뢰하도록 빌드한 테스트 바이너리에서 다음 명령은 원격 API를 호출하지 않는다.

```bash
TELLUS_ENGINE_TEST_LICENSE=1 npm run test:engine-local
TELLUS_ENGINE_TEST_LICENSE=1 npm run test:engine-local -- --mic
```

기본 모드는 실제 SDK/NAPI SHA 일치, 로컬 permit 승인, 장치 접근 전 no-input 설정 거절과
승인 폐기 후 start/resume 거절을 검증한다. `--mic`는 먼저 `npm run build`한 앱의 initializer로
Silero를 preload하고 실제 16kHz Opus 캡처, pause/resume/stop 및 종료 후 callback 억제를 확인한다.
CI의 `.github/workflows/desktop-example.yml`은 장치 없는 모드만 실행한다. private SDK/example
checkout에는 두 저장소의 contents를 읽을 수 있는 `TELLUS_CI_REPOSITORY_TOKEN`을 설정하고,
workflow dispatch의 `sdk_ref`/`example_ref`로 후보 revision을 선택한다. 원격 workflow 실행과
실제 API 자격 증명 사용은 이번 로컬 검증에서 수행하지 않았다. 테스트 키 바이너리는 배포하지 않는다.

After setup, verify real engine authorization against the endpoints in `.env`:

```bash
npm run test:engine-auth
```

This creates and ends its own conversation, verifies native approval and invalid-token rejection,
and never enables microphone or speaker capture. For a dev-only test, change the three HTTP/WS/download
base URLs in your ignored `.env` to `https://devrtsapi.tellus.ai.kr` / `wss://devrtsapi.tellus.ai.kr`
and use a dev login `API_KEY`; the checked-in defaults remain staging.

## Live Development Server Smoke Test

Like the web smoke test, this uses `API_KEY` from `.env` only as a Bearer token and never prints it. It
creates a Conversation, connects both WebSockets without an Origin header as the app does, sends PCM16 audio,
and ends the Conversation in `finally`. Set `SMOKE_ORIGIN` to check how the server treats a browser origin.

```bash
npm run test:live
```
