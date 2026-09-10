# Mobile Realtime Translation Example

A standalone Expo/React Native example that connects directly to the Tellus staging Realtime Speech server.

See the root [`README.md`](../README.md#api-contract-snapshot-2026-09-10) for the
Swagger snapshot of the REST and WebSocket contracts used by this example.

## Run

```bash
cp .env.example .env
npm install
npm run ios
# or npm run android
```

You can also use the development script.

```bash
./dev.sh          # Start the Expo development client server
./dev.sh ios      # Run the iOS development build
./dev.sh android  # Run the Android development build
```

Because this example uses a native audio module, it requires a development build rather than Expo Go.
Set an OAuth access token in `API_KEY` in `.env`, select two different languages, and start the session.
The token cannot be entered or changed in the app UI. Restart the development server after changing
environment variables.

## Environment

- HTTP: `https://stgrtsapi.tellus.ai.kr`
- WebSocket: `wss://stgrtsapi.tellus.ai.kr`
- Audio: PCM16, 16 kHz, mono, 20 ms
- Client VAD: Silero VAD v6.2.1 ONNX + `onnxruntime-react-native` 1.24.3

Set `EXPO_PUBLIC_APP_ORIGIN` to an origin allowed by the Realtime Speech server.

`API_KEY` is not committed to the source repository, but it is included in the client bundle when the mobile
app runs. Values deployed to a mobile client cannot be considered secret, so use a short-lived, restricted
access token.

## Selecting VAD

Enable **Voice Activity Detection** before starting to run Silero client VAD on the device and send
`client_vad: true` in the server settings. It uses 0.5/0.35 hysteresis and a 550 ms hangover policy, and sends
the gate-boundary status before the corresponding PCM frame. Silent PCM continues to be transmitted without
interruption. When disabled, the app does not load the model and sends `client_vad: false` with a disabled VAD
status to use server VAD. This setting cannot be changed during a session.

Because ONNX Runtime is a native module, rebuild the development build after changing dependencies.
A small `patch-package` compatibility patch is applied during installation so Expo autolinking recognizes
ONNX Runtime as a valid React Native module. If you keep the native iOS directory, also run
`npx pod-install ios`.

The model comes from the Silero team's official v6.2.1 tag:
`https://github.com/snakers4/silero-vad/blob/v6.2.1/src/silero_vad/data/silero_vad.onnx`.
Its SHA-256 hash is `1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3`, and
`npm run verify:vad-model` verifies it. The license is included in `assets/models/VADSileroLicense.md`.

## Customizing the Design

Replace the screens in `src/components/` to apply your own design. Communication and audio processing are
encapsulated behind `useRealtimeTranslation()`. Recording pauses when the app moves to the background and
must be resumed by the user after the app returns to the foreground.

VAD-specific source files, tests, and verification scripts all start with `VAD`. The toggle and status UI are
in `src/components/VADControl.tsx`, while the policy and Silero runtime are in `src/audio/VAD*.ts`.
Keep the official Silero model filename and the third-party patch filename required by `patch-package`.

## Verification

```bash
npm run type-check
npm test
npm run verify:vad-model
```
