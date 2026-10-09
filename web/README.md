# Web Realtime Translation Example

Vite/React 예제입니다. `@tellus-ai/audio-sdk-web`의 Rust WASM 엔진으로 마이크 오디오를 처리하고 Tellus Realtime Speech 서버로 전송합니다.

See the root [`README.md`](../README.md#api-contract) for the
Swagger snapshot of the REST and WebSocket contracts used by this example.

## Run

```bash
cp .env.example .env
npm run setup
npm run dev
```

You can also use the development script.

```bash
./dev.sh
```

`npm run setup` 전에 `.env`의 `TELLUS_AUDIO_ENGINE_TOKEN`에 Tellus에서 발급한 설치 토큰을 설정합니다. 설치 토큰은 실행 시 사용하는 OAuth `API_KEY`와 별개입니다. setup은 토큰을 먼저 검사하고 `npm ci`, SDK 설치기, `prepare:engine`을 순서대로 실행합니다. npm lifecycle 스크립트를 비활성화한 경우에도 SDK 설치기를 직접 실행하여 엔진과 모델 설치를 확인합니다. 다운로드 서버는 `TELLUS_AUDIO_DOWNLOAD_BASE_URL`로 지정합니다. 설치 토큰에 `VITE_` 접두사를 붙이지 않습니다.

SDK의 `vendor/web`에 엔진 `.mjs`·`.wasm`과 암호화 모델이 준비되어 있어야 합니다. `prepare:engine`은 SDK의 자산 복사 도구로 `public/tellus-audio/`를 생성하며 `dev`와 `build` 전에 자동 실행됩니다. 엔진 또는 SDK를 변경했으면 먼저 SDK를 다시 빌드합니다. 배포 서버의 모델 키 등록은 복사한 모델 manifest의 `keyId`와 일치해야 합니다.

Set an OAuth access token in `API_KEY` in `.env`, select two different languages, and start the session.
The token cannot be entered or changed in the browser UI. Restart the development server after changing
environment variables.

You can select the voice activity detection method before starting. The default is **Use Silero client VAD**,
and it cannot be changed while a session is active. Turning the toggle off selects **Use server VAD**. In this
mode, the browser does not load the Silero model and saves `client_vad: false`.

## 엔진과 환경

- HTTP 기본값: `https://stgrtsapi.tellus.ai.kr`
- WebSocket 기본값: `wss://stgrtsapi.tellus.ai.kr`
- 전송: Rust Opus, 16 kHz, mono, 20 ms
- `VITE_TELLUS_AUDIO_ASSET_BASE`: 엔진·ORT·암호화 모델 자산의 기준 URL. 기본값은 문서 URL 기준 `tellus-audio/`입니다.
- `VITE_TELLUS_DENOISE=true`: FastEnhancer를 활성화합니다. 기본값은 `false`입니다.

Start 버튼에서 AudioContext를 준비한 뒤 `/audio`의 엔진 permit을 검증하고 HPKE 모델 키를 적용합니다. 암호화 모델 복호화와 모델 로드는 Rust 엔진에서 수행하며 승인 완료 뒤 마이크를 시작합니다. OAuth 토큰이나 모델 콘텐츠 키를 SDK 자산에 포함하지 않습니다.

AudioWorklet은 브라우저가 제공한 입력 프레임을 Worker로 전달합니다. Rust가 LPF·resample·AEC·FastEnhancer·DSP·limiter·Silero·Opus를 처리합니다. 브라우저 마이크의 echo cancellation, noise suppression, auto gain control은 비활성화합니다. ORT Web `1.24.1`은 Worker에서 single-thread WASM으로 실행합니다. `SharedArrayBuffer`와 교차 출처 격리 헤더는 필요하지 않습니다.

Silero 기본 positive/negative threshold는 `0.5` / `0.35`, silence는 `550 ms`, pre-speech는 `500 ms`입니다. SDK가 반환한 gate 전이만 UI와 `audio.status`에 반영하며 해당 오디오보다 먼저 전송합니다. gate가 닫혀도 오디오 전송을 유지합니다. SDK 출력의 `validSampleCount`는 마지막 패딩 프레임의 실제 샘플 수를 나타냅니다.

마이크는 HTTPS 또는 localhost에서 사용할 수 있습니다. 배포 origin은 Realtime Speech 서버에서 허용되어야 합니다. 탭이 숨겨지면 승인을 취소하고, 다시 보일 때 새 permit을 얻어 마이크를 재개합니다. SDK 초기화는 클릭 전에 가능하며 AudioContext는 캡처를 시작할 때 재개합니다.

`API_KEY`는 빌드 시 클라이언트 번들에 포함됩니다. 브라우저에 배포하는 값에는 짧은 유효기간과 제한된 권한의 OAuth 토큰을 사용합니다.

관련 공식 문서: [AudioWorklet 입력 프레임](https://developer.mozilla.org/en-US/docs/Web/API/AudioWorkletProcessor/process), [ORT WASM 환경 설정](https://onnxruntime.ai/docs/tutorials/web/env-flags-and-session-options.html), [Emscripten Asyncify](https://emscripten.org/docs/porting/asyncify.html).

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
| `/audio` closed | Pauses the microphone and shows `reconnecting`. On the new socket a fresh native permit is required before capture resumes, and the wire sample cursor restarts at 0. The example sends an `audio.status` when authorization completes, which the server may ignore because no audio has arrived yet; VAD gate events follow with the audio frames. A session that was paused stays paused. |
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

SDK 연결점은 `src/audio/BrowserMicrophone.ts`, 자산 URL은 `src/config/browserEngineAssets.ts`입니다. VAD UI는 `src/components/VADControl.tsx`와 `src/audio/vad/VADTypes.ts`에 있습니다. 오디오 처리와 모델 추론 코드는 SDK와 공통 Rust 엔진에 있습니다.

## Verification

```bash
npm run verify:pre-commit
```

## 실제 브라우저 엔진 검증

`test:engine-browser`는 공개 CI 테스트 서명 키로 빌드한 엔진과 그 테스트용 CEK로 패키징한 모델이 필요합니다. 릴리스 엔진이나 운영 키를 사용하지 않습니다.

```bash
TELLUS_ENGINE_TEST_LICENSE=1 \
TELLUS_TEST_MODEL_KEY_FILE=/absolute/path/to/test-content-key.txt \
npm run test:engine-browser
```

이미 설치된 Chromium을 사용할 때는 `TELLUS_CHROMIUM_PATH`를 실행 파일 경로로 지정합니다. 테스트는 브라우저를 다운로드하지 않습니다. 임시 빌드와 결과는 `TMPDIR` 아래에 생성합니다.

이 테스트는 실제 production 웹 번들, AudioWorklet, ORT, Rust WASM, 암호화 FE/Silero, Opus를 실행합니다. localhost 서버는 테스트 permit·HPKE 키·REST·번역 결과만 제공합니다. 승인 전 입력 차단, 마이크 OS DSP 비활성화, pause/resume/reset, 재생과 취소, VAD 전이, 재연결·승인 거절 후 출력 차단을 검증합니다. 테스트 서버의 번역 문장은 외부 번역 서비스 검증 결과가 아닙니다.

## 기존 서버 계약 Smoke Test

이 스크립트는 SDK를 경유하지 않는 기존 서버 PCM16 계약 검사입니다. 실제 엔진 검증에는 `test:engine-browser`를 사용합니다.

The test uses `API_KEY` from `.env` only as a Bearer token and never prints it. It creates a Conversation,
verifies both WebSocket connections and PCM16 transmission, and then terminates the Conversation in `finally`.

```bash
npm run test:live
```
