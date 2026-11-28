# Flutter 실시간 번역 예제

Flutter 3.50(Dart 3.14) 이상으로 만든 iOS·Android 앱이다. Flutter plugin `tellus_audio_sdk`가 OS 캡처, denoise, Opus 인코딩을 처리한다. 앱은 인코딩된 payload만 `/v1/audio`로 전달한다. 서버 호출은 모두 `/v1` 경로를 사용한다.

```sh
cp .env.example .env
# .env의 TELLUS_AUDIO_ENGINE_TOKEN과 API_KEY를 각각 설정한다.
npm run setup
npm start
# 기기를 지정할 때: npm start -- -d <device>
```

`npm start`(`scripts/run.mjs`)는 아래를 순서대로 실행한다. Flutter가 종료하면 개발 서버도 종료한다.

1. `.env`에서 앱에 전달할 값만 골라 `.dart-defines.json`에 쓴다(`scripts/dart-defines.mjs`).
2. 개발 서버(`scripts/dev-server.mjs`)를 시작한다.
3. `adb reverse tcp:8787 tcp:8787`을 시도한다(포트는 `TELLUS_EXAMPLE_SERVER_PORT`를 따른다). adb나 Android 기기가 없어 실패해도 계속한다.
4. `flutter run --dart-define-from-file=.dart-defines.json`을 실행한다. `--` 뒤의 인자는 `flutter run`에 그대로 전달한다. 기기 ID는 `flutter devices`로 확인한다.

IDE에서 앱을 실행할 때는 `npm run server`로 개발 서버만 실행하고, `node scripts/dart-defines.mjs`로 만든 `.dart-defines.json`을 `--dart-define-from-file`에 지정한다. `.env`를 `--dart-define-from-file`에 직접 지정하지 않는다. Flutter는 `.env` 형식도 읽으므로 `API_KEY`가 앱에 들어간다.

## setup이 하는 일

`npm run setup`은 `TELLUS_AUDIO_ENGINE_TOKEN`을 먼저 확인하고, 설치 토큰이 없으면 아무것도 내려받지 않고 종료한다. `API_KEY`는 개발 서버가 런타임에 쓰는 키이므로 설치 토큰을 대신하지 않는다. 그다음 아래를 순서대로 실행하며, 한 단계가 실패하면 그 자리에서 멈춘다.

1. 공개 SDK 저장소에서 `scripts/audio-sdk-release.json`에 고정한 tag를 `.sdk/`에 내려받고(이미 있으면 그대로 사용한다) 고정 커밋과 같은지 확인한다.
2. `.sdk/`에서 `npm ci --ignore-scripts`와 `npm run build`를 실행한다.
3. `.sdk/platforms/flutter/dist/installer/install-binary-cli.js`로 iOS와 Android의 네이티브 엔진을 설치하고, `check-binary-cli.js`로 설치 결과를 검사한다.
4. `flutter pub get`을 실행한다. `pubspec.yaml`의 `tellus_audio_sdk`는 `.sdk/platforms/flutter`를 가리키는 path 의존성이다.

한 플랫폼의 엔진만 설치하려면 `TELLUS_AUDIO_ENGINE_PLATFORM=ios` 또는 `android`를 지정한다. 설치 서버는 `TELLUS_AUDIO_DOWNLOAD_BASE_URL`로 지정하며, 없으면 `REALTIME_SPEECH_HTTP_URL`, `https://public.speech.tellus.ai.kr` 순서로 선택한다.

`.sdk/`는 setup이 관리하는 로컬 빌드 캐시이며 Git에서 제외한다. 다른 SDK 버전이 들어 있으면 삭제 후 `npm run setup`을 다시 실행한다.

## 준비물

- Flutter 3.50 이상, Node.js 24, Git
- iOS: Xcode와 CocoaPods. 최소 iOS 15.1이며, 시뮬레이터는 Apple Silicon Mac에서만 실행할 수 있다.
- Android: Android SDK와 NDK. `minSdk` 24이며, ABI는 `arm64-v8a`와 `x86_64`를 지원한다.

## API 키와 연결 입장권

앱이 가진 값은 앱을 가진 사람이 꺼낼 수 있으므로 앱에는 API 키를 넣지 않는다. Flutter에는 Metro 같은 개발 서버가 없어서 이 예제는 `node:http`로 만든 작은 개발 서버를 함께 실행한다. 키는 Mac에서 실행하는 이 서버 프로세스에만 있고, 앱은 Conversation 하나를 15분 동안 여는 연결 입장권만 받는다.

```text
앱                                     개발 서버 (scripts/dev-server.mjs)    Tellus
POST /__tellus/api/v1/conversations  →  + Authorization: Bearer <API 키>  →  POST /v1/conversations
POST /__tellus/api/v1/conversations/{id}/settings ──────────────────────→  POST /v1/conversations/{id}/settings
POST /__tellus/api/v1/access-tokens  ───────────────────────────────────→  POST /v1/access-tokens
                                     ←  { access_token, expires_at_ms }
WS /v1/conversations/{id}/results  (Authorization: Bearer <입장권>) ──────────────────────────────→  Tellus
WS /v1/audio?conversation_id={id}&audio_format=opus  (Authorization: Bearer <입장권>) ───────────→  Tellus
POST /__tellus/api/v1/conversations/{id}/end ───────────────────────────→  POST /v1/conversations/{id}/end
```

- `scripts/conversation-api-middleware.cjs`가 서버 쪽이다. `scripts/dev-server.mjs`가 녹음 저장 middleware와 함께 등록한다. 이 네 호출만 `REALTIME_SPEECH_HTTP_URL`로 전달하며 API 키를 붙인다. `/__tellus/api` 아래의 다른 경로는 `404`다. Tellus의 상태 코드와 본문을 그대로 돌려주고, Tellus에 연결하지 못하면 `502`, 15초 안에 응답이 없으면 `504`를 돌려준다. `npm run test:scripts`로 검사한다.
- 앱은 이 호출에 자격 증명을 보내지 않고 `X-Tellus-Example-Api: 1` 헤더만 보낸다. middleware는 이 헤더가 있고 `Origin`이 없거나 자기 주소인 요청만 받는다. 앱의 HTTP client는 `Origin`을 보내지 않으므로 앱은 통과하고, 다른 웹 페이지는 거절된다. 페이지의 `Origin`은 `localhost`나 IP 주소일 때만 자기 주소로 본다. 다른 도메인의 이름을 이 Mac으로 돌리는 DNS rebinding을 막기 위해서다.
- 앱은 `TELLUS_EXAMPLE_SERVER_URL`(기본값 `http://localhost:8787`)로 개발 서버를 찾는다. 개발 서버 없이 실행하는 빌드에서는 `.env`의 `TELLUS_EXAMPLE_API_URL`에 같은 네 경로를 제공하는 서버 주소를 지정한다(예: `https://your-backend.example/tellus`).
- 입장권은 이 Conversation만 연다. 결과 socket과 `/v1/audio` socket은 Tellus에 직접 열며, 입장권은 URL이 아니라 handshake의 `Authorization` 헤더로 보낸다. 앱은 남은 시간이 1분 이하인 입장권을 새로 발급받아 재연결과 엔진 승인에 사용한다. 열린 socket은 입장권이 만료되어도 닫히지 않는다.

개발 서버는 기기가 접속할 수 있도록 모든 네트워크 인터페이스에서 대기한다. 그래서 middleware는 이 Mac에서 온 호출(loopback)만 받는다.

- iOS 시뮬레이터는 Mac의 `localhost`를 그대로 사용하므로 설정 없이 동작한다.
- Android 에뮬레이터와 USB로 연결한 Android 기기는 `npm start`가 실행하는 `adb reverse tcp:8787 tcp:8787`로 기기의 `localhost:8787`을 Mac에 연결하며, 호출은 loopback으로 들어온다. 에뮬레이터를 포함해 Android 기기가 둘 이상 연결되어 있으면 이 명령이 실패하므로 `ANDROID_SERIAL`로 기기를 지정하거나 `adb -s <serial> reverse tcp:8787 tcp:8787`을 직접 실행한다.
- Wi-Fi로 접속하는 실기기는 `.env`의 `TELLUS_EXAMPLE_SERVER_URL`에 Mac의 IP(예: `http://192.168.0.10:8787`)를, `TELLUS_EXAMPLE_API_CLIENTS`에 그 기기의 IP를 쉼표로 구분해 적는다. iPhone 실기기에는 `adb reverse`에 해당하는 방법이 없으므로 이 방법을 사용한다.

다른 주소의 호출은 경로와 관계없이 `403`이고, 개발 서버 터미널에 거절한 주소를 주소마다 한 번 표시하므로 추가할 IP를 거기서 확인할 수 있다. 같은 Wi-Fi의 다른 사람은 이 키를 쓸 수 없다. 단, 허용한 IP를 다른 기기가 쓰면 그 기기도 호출할 수 있다.

**이 개발 서버가 실제 백엔드로 바꿀 부분이다.** IP 허용 목록은 개발용 방어일 뿐이고, middleware는 호출한 사람이 누구인지 확인하지 않는다. 실제 서비스의 백엔드는 자체 로그인 세션을 먼저 확인한 뒤 그 사용자를 위해 이 호출을 한다.

## 오디오와 denoise

- 처리·전송: Opus, 16kHz mono, 20ms
- denoise: 기본 비활성화이며 `.env`의 `TELLUS_DENOISE=true`로 켠 상태에서 시작할 수 있다. 켜면 `close_talk` 모드로 동작해 마이크 가까이에서 말한 소리만 통과시키고 먼 소리는 무음으로 만든다. **Noise Reduction (Denoise)** 스위치로 Start 전과 녹음·일시정지 중에 변경할 수 있고, **Audio SDK denoise**에 적용 상태를 표시한다.
- VAD: 앱에서 VAD를 실행하지 않는다. settings에 `client_vad: false`를 저장하고 gate 이벤트를 보내지 않으므로, 발화 경계는 서버 VAD가 정한다.
- 마이크 재시작: iOS가 오디오 하드웨어 구성(샘플레이트 등)을 바꾸면 OS 오디오 엔진이 멈춘다. 이때 같은 승인으로 마이크를 한 번 다시 시작하며, 1분 안에 다시 바뀌거나 재시작이 실패하면 오류로 세션을 끝낸다. 다른 캡처 오류는 바로 세션을 끝낸다.

네트워크 종료·재연결 정책은 [공통 API 문서](../README.md#api-contract)를 따른다.

## 설정

`.env`의 값은 환경 변수로도 지정할 수 있으며, 둘 다 있으면 환경 변수를 우선한다.

| 변수 | 읽는 곳 | 설명 |
| --- | --- | --- |
| `API_KEY` | 개발 서버 | Tellus API 콘솔에서 발급한 API 키. 앱에는 설정 여부만 전달한다. |
| `REALTIME_SPEECH_HTTP_URL` | 개발 서버 | REST 호출을 전달할 주소. 기본값 `https://public.speech.tellus.ai.kr` |
| `REALTIME_SPEECH_WS_URL` | 앱 | 앱이 직접 여는 WebSocket 주소. 기본값 `wss://public.speech.tellus.ai.kr` |
| `APP_ORIGIN` | 앱 | WebSocket handshake의 `Origin`. 서버에서 허용한 값을 지정한다. 기본값 `https://devapp.tellus.ai.kr` |
| `TELLUS_EXAMPLE_SERVER_PORT` | 개발 서버 | 개발 서버 포트. 기본값 `8787` |
| `TELLUS_EXAMPLE_SERVER_URL` | 앱 | 앱이 개발 서버에 접속하는 주소. 기본값 `http://localhost:<포트>` |
| `TELLUS_EXAMPLE_API_URL` | 앱 | 개발 서버 대신 사용할, 같은 네 경로를 제공하는 서버 |
| `TELLUS_EXAMPLE_API_CLIENTS` | 개발 서버 | loopback 외에 호출과 녹음 저장을 허용할 기기 IP(쉼표로 구분) |
| `TELLUS_DENOISE` | 앱 | `true`이면 denoise를 켠 상태로 시작한다. |
| `TELLUS_AUDIO_DOWNLOAD_BASE_URL` | setup | 엔진을 내려받을 서버. 설치 토큰의 환경과 같아야 한다. |
| `TELLUS_AUDIO_ENGINE_TOKEN` | setup | Tellus API 콘솔에서 발급한 설치 토큰 |

앱에 전달하는 값은 `.dart-defines.json`의 여섯 개(`TELLUS_API_KEY_CONFIGURED`, `TELLUS_EXAMPLE_SERVER_URL`, `TELLUS_EXAMPLE_API_URL`, `REALTIME_SPEECH_WS_URL`, `APP_ORIGIN`, `TELLUS_DENOISE`)뿐이며 `lib/src/config/realtime_speech_config.dart`가 읽는다. API 키와 설치 토큰은 이 파일에 쓰지 않는다. 이 값은 빌드할 때 앱에 들어가고 개발 서버는 시작할 때 `.env`를 읽으므로, 설정을 바꾼 뒤에는 `npm start`를 다시 실행한다.

## 검증

```sh
npm run verify:pre-commit
```

`flutter analyze`, `flutter test`, `npm run test:scripts`를 순서대로 실행한다. `test:scripts`는 개발 서버와 두 middleware, `.dart-defines.json`에 API 키와 설치 토큰이 들어가지 않는지, setup과 `npm start`의 실행 순서를 `node --test`로 검사한다.

네이티브 SDK가 앱에 연결되었는지는 setup을 마친 뒤 실행 중인 시뮬레이터, 에뮬레이터 또는 기기에서 확인한다. 서버, API 키, 마이크 권한은 필요하지 않다.

```sh
flutter test integration_test/sdk_smoke_test.dart -d <device>
```

CI(`.github/workflows/examples.yml`)는 secret 없이 모든 PR에서 설치 회귀 테스트와 `flutter analyze`, `flutter test`, `npm run test:scripts`, 그리고 API 키가 `.dart-defines.json`에 들어가지 않는지를 검사한다. 엔진 설치와 위 integration test는 CI에서 실행하지 않으므로 로컬에서 실행한다.

## 로컬 캡처 음성 다운로드

**Start → Stop → Download Audio** 순서로 SDK가 캡처한 음성을 `tellus-recording-<timestamp>.ogg` 파일로 저장한다. 저장 위치는 **개발 서버를 실행하는 Mac의 `~/download`**다. 앱이 `TELLUS_EXAMPLE_SERVER_URL`의 `/__tellus/recordings/`로 파일을 전송하고, 개발 서버의 `scripts/recording-download-middleware.cjs`가 소문자 `download` 폴더를 생성해 저장한다. 저장도 API 호출처럼 이 Mac(loopback)과 `TELLUS_EXAMPLE_API_CLIENTS`의 주소에서만 받는다. 완료 후 Mac의 실제 저장 경로를 표시한다. 기존 파일은 덮어쓰지 않는다.

이 기능은 개발 서버 연결이 필요하다. 앱 내부나 기기의 Download 폴더에는 저장하지 않는다.
