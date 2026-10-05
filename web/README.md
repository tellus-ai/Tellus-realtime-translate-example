# Web Realtime Translation Example

A standalone Vite/React example that connects directly to the Tellus staging Realtime Speech server.

See the root [`README.md`](../README.md#api-contract) for the
Swagger snapshot of the REST and WebSocket contracts used by this example.

## Run

```bash
cp .env.example .env
npm install
npm run dev
```

You can also use the development script.

```bash
./dev.sh
```

Set an OAuth access token in `API_KEY` in `.env`, select two different languages, and start the session.
The token cannot be entered or changed in the browser UI. Restart the development server after changing
environment variables.

You can select the voice activity detection method before starting. The default is **Use Silero client VAD**,
and it cannot be changed while a session is active. Turning the toggle off selects **Use server VAD**. In this
mode, the browser does not load the Silero model or ONNX Runtime and saves `client_vad: false`.

## Environment

- HTTP: `https://stgrtsapi.tellus.ai.kr`
- WebSocket: `wss://stgrtsapi.tellus.ai.kr`
- Audio: Opus (WebCodecs 지원 시), PCM16 런타임 폴백, 16 kHz, mono, 20 ms

## Client VAD

This example does not depend on `@tellus-ai/audio-sdk`. It runs the official Silero VAD v6.2.1 ONNX model
in an `onnxruntime-web@1.24.1` Web Worker.

- positive/negative threshold: `0.5` / `0.35`
- minimum silence: `550 ms` (`8,800` samples)
- inference input: `512` samples + `64` context
- recurrent state: `[2, 1, 128]`, sample rate tensor: int64 scalar `16000`
- the session ends without dropping audio after `8` consecutive inference errors or a FIFO backlog of `10` frames (`200 ms`)
- level: `0.5` medium, `0.65` strong, `0.85` veryStrong

Every 20 ms, the same Float32 samples are used to create the VAD input and PCM16 source audio. When
`AudioEncoder` and `AudioData` are available, a dedicated Worker encodes that source as raw Opus at 64 kbps;
otherwise the source is sent as PCM16. VAD and uplink are serialized through a single FIFO, and a gate-transition
`audio.status` event is sent before the corresponding audio frame. Silent audio continues to be transmitted.
When reconnecting, the sample cursor for the new Audio WebSocket resets to `0`, while `status_seq` continues
to increase throughout the conversation.

The model comes from
[`v6.2.1/src/silero_vad/data/silero_vad.onnx`](https://github.com/snakers4/silero-vad/blob/v6.2.1/src/silero_vad/data/silero_vad.onnx)
in the official Silero repository. Its SHA-256 hash is
`1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3`.
`npm run verify:vad-model` verifies the model before each build. Silero VAD is licensed under the MIT License.

ONNX Runtime `.mjs` and `.wasm` files are served from `public/ort/` instead of a CDN.
`npm install`, `npm run dev`, and `npm run build` automatically copy the required files from the exact-pinned package.

The microphone is available only over HTTPS or localhost. The deployment domain and local Vite origin must
be registered as allowed origins on the Realtime Speech server.

`API_KEY` is not committed to the source repository, but it is included in the client bundle when the web
application is built. Values deployed to a browser cannot be considered secret, so use a short-lived,
restricted access token.

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
| Any other `1008` | Stops with the server message and calls `POST /end`. |
| `1012` | Reopens the socket after a random 0.5–2 seconds, then backs off. |
| Any other close code, including `1006`, `1011`, and `1013` | Reopens the socket after 1, 2, 5, 10, then every 30 seconds, or after `retry_after_ms` when that is longer. A socket that closes while a reconnect is already waiting is reopened by that reconnect. |
| A socket closes, or is not usable within 10 seconds, while starting (until both sockets are open and the microphone has started, that is, before the status is `recording`) | The start fails. Nothing is reconnected. |
| Only the Result WebSocket closed | Recording and `/audio` continue. Only Result is reopened. |
| `/audio` closed | Pauses the microphone and shows `reconnecting`. On the new socket the sample cursor restarts at 0 and the VAD and encoder are reset. The example sends an `audio.status` when the socket opens, which the server may ignore because no audio has arrived yet; VAD gate events follow with the audio frames. A session that was paused stays paused. |
| Both sockets closed | Opens Result first and `/audio` after `participants.snapshot`. |
| A reconnect attempt is not usable within 10 seconds, or closes again | Moves to the next backoff step. The steps start over after both sockets stayed open for 30 seconds. |
| Browser `online` event | A reconnect that is waiting runs at once. `offline` is ignored. |
| Result reconnected | Shows the results that arrive from then on. Results sent while the Result WebSocket was closed are not recovered. |
| Stop | Sends `speech_gate_closed` (if the gate is open) and `idle`, waits up to 2 seconds for the last finals, closes `/audio`, calls `POST /end`, and keeps Result open until `conversation.ended` or for 5 more seconds. |
| REST `503` | Retries after 1, 2, and 5 seconds. A request that gets no response, which includes the 15-second request timeout, is retried only for `POST /end`. `POST /end` treats `410` and `404` as ended. When every retry fails, the example gives up; if the request was `POST /end`, the Conversation stays open until its state expires 24 hours after creation. |

A reconnect shows only in the status (`reconnecting` while `/audio` is down) and in the connection state of
each socket. The close code and reason are not shown. `error` holds the message that stopped the session; a
malformed message on the Result WebSocket also sets it, and the session continues.

Source files:

- `src/realtime/closePolicy.ts`: what each close means, and the backoff steps.
- `src/realtime/RealtimeTranslationSession.ts`: sockets, reconnects, and the Stop sequence.
- `src/realtime/resultParser.ts`: `system.error` and `participants.snapshot`.
- `src/realtime/transcriptReducer.ts`: `awaitsFinal` tells which rows Stop still waits for.
- `src/api/conversationApi.ts` and `src/api/httpClient.ts`: `POST /end` statuses and `503` retries.

Not implemented:

- Reconnecting when no result arrives for 20 seconds while the speaker is talking.
- Watching `bufferedAmount` on `/audio`.
- Reconnecting `/audio` after 10 minutes without audio.
- Filling in finals missed while the Result WebSocket was closed, with `GET /conversations/{id}/messages`.
  [Reconnecting after a disconnect](../README.md#reconnecting-after-a-disconnect) describes how.
- Calling `POST /end` when the tab is closed. It is called on Stop, when the component unmounts, and when the
  session stops with an error, unless the close was `audio_connection_replaced` or the server had already
  reported the Conversation as ended.

## Customizing the Design

Replace `src/components/` and `src/styles.css` to apply your own design. API, WebSocket, and audio processing
are encapsulated behind `useRealtimeTranslation()`.

VAD-specific source files, tests, and verification scripts all start with `VAD`. The toggle and status UI are
in `src/components/VADControl.tsx`, while the policy and Worker implementation are in `src/audio/vad/VAD*.ts`.
Keep the original filenames of the third-party `.mjs` and `.wasm` files that ONNX Runtime resolves by name,
as well as the official model filename.

## Verification

```bash
npm run typecheck
npm test
npm run build
```

## Live Development Server Smoke Test

The test uses `API_KEY` from `.env` only as a Bearer token and never prints it. It creates a Conversation,
verifies both WebSocket connections and PCM16 transmission, and then terminates the Conversation in `finally`.

```bash
npm run test:live
```
