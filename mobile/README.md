# Mobile Realtime Translation Example

A standalone Expo/React Native example that connects directly to the Tellus staging Realtime Speech server.

See the root [`README.md`](../README.md#api-contract) for the
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
| Any other close code, including `1006`, `1011`, and `1013` | Reopens the socket after 1, 2, 5, 10, then every 30 seconds, or after `retry_after_ms` when that is longer. A socket that closes while a reconnect is already waiting is reopened by that reconnect. A close event that React Native delivers without a code is handled as `1006`. |
| A socket closes, or is not usable within 10 seconds, while starting (until both sockets are open, that is, before the status is `recording`) | The start fails. Nothing is reconnected. The microphone starts after that; a socket that closes while it starts is reconnected. |
| Only the Result WebSocket closed | Recording and `/audio` continue. Only Result is reopened. |
| `/audio` closed | Pauses the microphone and shows `reconnecting`. On the new socket the sample cursor restarts at 0 and the client VAD is reset. The example sends an `audio.status` when the socket opens, which the server may ignore because no audio has arrived yet; VAD gate events follow with the audio frames. A session that was paused, or is paused while `/audio` reconnects, comes back paused. |
| Both sockets closed | Opens Result first and `/audio` after `participants.snapshot`. |
| A reconnect attempt is not usable within 10 seconds, or closes again | Moves to the next backoff step. The steps start over after both sockets stayed open for 30 seconds. |
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
- Reconnecting at once when the network comes back, which the web example does on the browser `online`
  event. The app does not listen for network changes, so a reconnect that is waiting runs when its backoff
  delay ends.
- Calling `POST /end` when the app is terminated, by the user or by the system. It is called on Stop, when
  the component unmounts, and when the session stops with an error, unless the close was
  `audio_connection_replaced` or the server had already reported the Conversation as ended. Moving to the
  background only pauses recording, and the Conversation stays open.

## Customizing the Design

Replace the screens in `src/components/` to apply your own design. Communication and audio processing are
encapsulated behind `useRealtimeTranslation()`. Recording pauses when the app moves to the background and
must be resumed by the user after the app returns to the foreground. This also applies while `/audio` is
reconnecting. A session that is still starting (`creating`, `configuring`, or `connecting`) is not paused.

VAD-specific source files, tests, and verification scripts all start with `VAD`. The toggle and status UI are
in `src/components/VADControl.tsx`, while the policy and Silero runtime are in `src/audio/VAD*.ts`.
Keep the official Silero model filename and the third-party patch filename required by `patch-package`.

## Verification

```bash
npm run type-check
npm test
npm run verify:vad-model
```
