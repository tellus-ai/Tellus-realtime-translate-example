# Web Realtime Translation Example

A standalone Vite/React example that connects directly to the Tellus staging Realtime Speech server.

See the root [`README.md`](../README.md#api-contract-snapshot-2026-09-10) for the
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
