# 모바일 실시간 번역 예제

Expo 55 / React Native 0.83.9 개발 앱이다. `@tellus-ai/audio-sdk-mobile` 0.3.13이 OS 캡처, Rust DSP·DeepFilterNet3 denoise·Silero VAD·Opus 인코딩을 처리한다. 앱은 인코딩된 payload와 gate 이벤트만 `/v1/audio`로 전달한다. 서버 호출은 모두 `/v1` 경로를 사용한다.

```sh
cp .env.example .env
# .env의 TELLUS_AUDIO_ENGINE_TOKEN과 API_KEY를 각각 설정한다.
npm run setup
npm run ios
# 또는 npm run android
```

`npm run setup`은 `TELLUS_AUDIO_ENGINE_TOKEN`을 먼저 확인하고 공개 SDK 0.3.13의 고정 커밋을 `.sdk/`에 준비·빌드한 뒤 `.env` 설정을 전달해 `npm ci --legacy-peer-deps`, SDK 설치기, 바이너리 검사를 순서대로 실행한다. 의존성 설치는 기존 lockfile과 CI의 peer dependency 설정을 따른다. 기본 설치 대상은 iOS와 Android이며 엔진·ONNX Runtime·암호화 모델 파일이 준비되었는지 확인한다. 설치 토큰이 없으면 의존성 설치 전에 종료한다. `API_KEY`는 Expo 개발 서버가 런타임에 쓰는 키이므로 설치 토큰을 대신하지 않는다. 설치 서버는 `TELLUS_AUDIO_DOWNLOAD_BASE_URL`로 지정하며, 없으면 `REALTIME_SPEECH_HTTP_URL`, `EXPO_PUBLIC_REALTIME_SPEECH_HTTP_URL`, staging 기본 주소 순서로 선택한다.

`./dev.sh [start|ios|android]`도 SDK 또는 엔진 파일이 없으면 같은 setup을 실행한다. setup 이후 `npm run ios` 또는 `npm run android`로 SDK가 포함된 개발 앱을 빌드한다.

Node.js 24와 Git이 필요하며 별도 SDK 폴더를 준비할 필요가 없다. `.sdk/platforms/mobile`의 SDK 0.3.13과 엔진 0.4.13을 사용한다. `.npmrc`의 `install-links=true`로 앱의 `node_modules`에 복사 설치한다. SDK installer가 플랫폼 binary와 `denoise.temc`, `vad.temc` 암호화 모델, 엔진 archive에 함께 들어 있는 ONNX Runtime(iOS `onnxruntime.xcframework`, Android `libonnxruntime.so`)을 준비해야 한다. ONNX Runtime을 CocoaPods나 Maven에서 따로 받지 않는다. iOS는 SDK resource bundle, Android는 SDK assets를 native reader가 사용한다. SDK Expo plugin이 마이크 권한과 Android 지원 ABI를 자동 생성하고 autolinking으로 SDK를 연결한다. 오디오 캡처 구현은 SDK에 위임하며 고객 앱에서는 React Native TypeScript API를 사용한다. Expo Go에는 SDK module이 없으므로 SDK가 포함된 개발 앱을 사용한다.

`.sdk/`는 setup이 관리하는 로컬 빌드 캐시다. 다른 SDK 버전이 들어 있으면 삭제 후 `npm run setup`을 다시 실행한다. SDK를 갱신한 뒤 기존 iOS host를 사용하는 경우 Pods를 갱신하고 앱을 다시 빌드한다.

```sh
(cd ios && pod install --no-repo-update)
npm run ios
# 또는 npm run android
```

`.env`의 `API_KEY`에 Tellus API 콘솔에서 발급한 API 키를 설정하고 서로 다른 두 언어를 선택한다. 키는 앱에 들어가지 않는다. 아래 «API 키와 연결 입장권»처럼 Mac의 Expo 개발 서버가 키를 갖고, 앱은 그 서버를 거쳐 `POST /v1/conversations`로 Conversation을 만들고 `POST /v1/conversations/{id}/settings`로 두 언어를 저장한 뒤 연결 입장권을 받는다. 결과 socket(`/v1/conversations/{id}/results`)과 `/v1/audio` socket은 Tellus에 직접 열며, handshake의 `Authorization: Bearer <입장권>` 헤더와 `Origin` 헤더로 인증한다. React Native는 WebSocket 헤더를 설정할 수 있으므로 입장권을 URL에 넣지 않는다. 결과 socket은 ready 메시지 없이 열리는 즉시 사용하고, 재연결할 때는 `after_order_seq`로 마지막으로 완료한 발화 번호를 전달해 끊긴 동안의 확정 결과를 다시 받는다. `/v1/audio` socket의 `attachEngineAuthorization.ready`가 permit과 모델 키를 적용한 뒤 마이크 권한을 요청하고 캡처를 시작한다. 엔진 승인과 갱신에도 그때의 입장권을 전달한다. 새 socket마다 같은 capture를 재승인하며, 승인 폐기 시 OS 캡처와 대기 출력도 중단한다.

- 처리·전송: Opus, 16kHz mono, 20ms
- denoise: DeepFilterNet3 기본 활성화, `denoiseMode: 'general'`(SDK 기본값 `close_talk`는 마이크에서 먼 소리를 무음으로 만들어 떨어져 있는 상대 화자의 말이 빠질 수 있다); `EXPO_PUBLIC_TELLUS_DENOISE=false`로 초기 비활성화 가능. **Noise Reduction (Denoise)** 스위치로 Start 전과 녹음·일시정지 중에 변경할 수 있다. SDK의 `setDenoiseEnabled()`로 적용한 뒤 `getStatus()`로 확인하며, **Audio SDK denoise**에 적용 상태를 표시한다. 선택값은 Stop 후 다음 세션에도 유지하고, 적용 실패는 번역을 종료하지 않고 표시한다.
- Audio SDK: SDK 활성화 설정에 따라 UI에 `사용 중 / 사용하지 않음` 표시; SDK 초기화 실패·미사용 시 Conversation 생성 전에 오류 표시
- VAD: audio-sdk 사용 시 클라이언트 VAD 비활성화 (`vadEnabled: false`, `client_vad: false`); SDK는 기본 활성화이므로 앱 실행 직후부터 정지·오류 후에도 토글을 OFF로 고정하고 클릭·변경 차단; `.env`의 `TELLUS_AUDIO_SDK_ENABLED=false`로 명시적으로 끈 경우에만 VAD 선택 가능 (SDK 미사용 세션 시작 오류 유지), gate 이벤트 전송 없음
- background·interruption·route 변경: 자동 캡처 재개 없이 중단하며 새 승인이 필요한 연결은 재승인 후 재개
- TTS: SDK `playback` 또는 `playbackEncoded`를 사용하면 OS 재생과 같은 PCM이 Rust AEC reference에 들어간다

`npm start`, `npm run ios`, `npm run android`와 이를 실행하는 `./dev.sh start`, `./dev.sh ios`, `./dev.sh android`는 모두 `mobile/.env`를 읽는다. `API_KEY`와 `REALTIME_SPEECH_HTTP_URL`은 Metro(`metro.config.js`)만 읽는다. WebSocket URL과 Origin은 `REALTIME_SPEECH_WS_URL`, `APP_ORIGIN`으로 설정하며, 공통 `app.config.ts`가 Expo `extra`를 통해 앱에 전달한다. 기존 `EXPO_PUBLIC_REALTIME_SPEECH_HTTP_URL`, `EXPO_PUBLIC_REALTIME_SPEECH_WS_URL`, `EXPO_PUBLIC_APP_ORIGIN`도 지원하고, 두 형식이 함께 있으면 접두사가 없는 변수를 우선한다. `APP_ORIGIN`에는 서버에서 허용한 값을 지정해야 한다. 설정 변경 후 실행 중인 Metro를 종료하고 사용할 실행 명령을 다시 실행한다. `extra`에는 키가 설정되었는지 여부(`apiKeyConfigured`)만 들어간다. partner secret이나 모델 content key도 앱에 넣지 않는다.

## API 키와 연결 입장권

앱이 가진 값은 앱을 가진 사람이 꺼낼 수 있으므로 앱에는 API 키를 넣지 않는다. 키는 Mac에서 실행하는 Expo(Metro) 개발 서버 프로세스에만 있고, 앱은 Conversation 하나를 15분 동안 여는 연결 입장권만 받는다.

```text
앱                                     Expo 개발 서버 (Metro)                Tellus
POST /__tellus/api/v1/conversations  →  + Authorization: Bearer <API 키>  →  POST /v1/conversations
POST /__tellus/api/v1/conversations/{id}/settings ──────────────────────→  POST /v1/conversations/{id}/settings
POST /__tellus/api/v1/access-tokens  ───────────────────────────────────→  POST /v1/access-tokens
                                     ←  { access_token, expires_at_ms }
WS /v1/conversations/{id}/results  (Authorization: Bearer <입장권>) ──────────────────────────────→  Tellus
WS /v1/audio?conversation_id={id}&audio_format=opus  (Authorization: Bearer <입장권>) ───────────→  Tellus
POST /__tellus/api/v1/conversations/{id}/end ───────────────────────────→  POST /v1/conversations/{id}/end
```

- `scripts/conversation-api-middleware.cjs`가 서버 쪽이다. `metro.config.js`가 녹음 저장 middleware와 함께 Metro에 등록한다. 이 네 호출만 `REALTIME_SPEECH_HTTP_URL`로 전달하며 API 키를 붙인다. `/__tellus/api` 아래의 다른 경로는 `404`다. Tellus의 상태 코드와 본문을 그대로 돌려주고, Tellus에 연결하지 못하면 `502`, 15초 안에 응답이 없으면 `504`를 돌려준다. `npm run test:api-server`로 검사한다.
- 앱은 이 호출에 자격 증명을 보내지 않고 `X-Tellus-Example-Api: 1` 헤더만 보낸다. middleware는 이 헤더가 있고 `Origin`이 없거나 자기 주소인 요청만 받는다. React Native의 fetch는 `Origin`을 보내지 않으므로 앱은 통과하고, 다른 웹 페이지는 거절된다.
- 서버 주소는 녹음 다운로드와 같은 방법(React Native `SourceCode`의 HTTP(S) 번들 URL 또는 Expo `hostUri`)으로 찾는다. Metro 없이 실행하는 빌드에서는 `.env`의 `TELLUS_EXAMPLE_API_URL`에 같은 네 경로를 제공하는 서버 주소를 지정한다(예: `https://your-backend.example/tellus`). 둘 다 없으면 Start가 오류를 표시한다.
- 입장권은 이 Conversation만 연다. `src/api/accessTokens.ts`가 현재 입장권을 보관하고, 남은 시간이 1분 이하일 때 요청을 받으면 새로 발급받는다. 재연결과, SDK가 `/v1/audio`에서 보내는 엔진 승인(`audio.authenticate`, `engine.renew`)마다 요청한다. 열린 socket은 입장권이 만료되어도 닫히지 않는다.

Metro는 기기가 접속할 수 있도록 로컬 네트워크에서 대기한다. 그래서 middleware는 이 Mac에서 온 호출(loopback)만 받는다. iOS 시뮬레이터, Android 에뮬레이터, `adb reverse tcp:8081 tcp:8081`로 연결한 Android 기기는 loopback으로 들어오므로 설정 없이 동작한다. Wi-Fi로 접속하는 실기기는 그 기기의 IP를 `.env`의 `TELLUS_EXAMPLE_API_CLIENTS`에 쉼표로 구분해 적는다. 다른 주소의 호출은 경로와 관계없이 `403`이고, Metro 터미널에 거절한 주소를 주소마다 한 번 표시하므로 추가할 IP를 거기서 확인할 수 있다. 같은 Wi-Fi의 다른 사람은 이 키를 쓸 수 없다. 단, 허용한 IP를 다른 기기가 쓰면 그 기기도 호출할 수 있다.

**이 middleware가 실제 백엔드로 바꿀 부분이다.** IP 허용 목록은 개발용 방어일 뿐이고, middleware는 호출한 사람이 누구인지 확인하지 않는다. 실제 서비스의 백엔드는 자체 로그인 세션을 먼저 확인한 뒤 그 사용자를 위해 이 호출을 한다.

```sh
npm run verify:pre-commit
```

네트워크 종료·재연결 정책은 [공통 API 문서](../README.md#api-contract)를 따른다. 마이크 payload의 `sampleCount`로 전송 cursor를 계산하고, `validSampleCount`는 마지막 padded 청크의 유효 범위를 나타낸다. Stop은 native flush를 승인된 socket에 전달한 뒤 최종 결과를 기다리고 Conversation을 종료한다.

공개 CI 서명 키를 신뢰하는 개발용 engine artifact와 테스트 CEK는 실제 배포에 사용하지 않는다.


Android host는 `app.json`과 SDK plugin으로 생성하는 로컬 산출물이므로 git에 저장하지 않는다. `npx expo prebuild --platform android --no-install`로 재생성할 수 있다. 기존 tracked iOS host는 유지하며 `prebuild --clean`으로 덮어쓰지 않는다. 새 CNG 앱에서는 [Expo 공식 흐름](https://docs.expo.dev/workflow/continuous-native-generation/)을 따라 두 플랫폼 모두 자동 생성할 수 있다.

실제 개발 앱 검증은 아래 명령을 사용한다. 앱을 설치·실행하고 localhost Metro를 시작한 뒤, 공개 CI 서명 키로 빌드한 테스트 artifact와 임시 CEK 경로를 지정한다. 마이크 payload를 저장하거나 송신하지 않고 metadata만 검사하며, 재생은 합성 WAV로 검사한다.

```sh
NODE_OPTIONS=--dns-result-order=ipv4first CI=1 npx expo start --dev-client --localhost --port 8088
TELLUS_ENGINE_TEST_LICENSE=1 METRO_URL=http://localhost:8088 node scripts/native-sdk-probe.mjs \
  /path/to/Tellus-audio-engine ./node_modules/@tellus-ai/audio-sdk-mobile/vendor/ios/models /path/to/test-content-key.txt
```

Android에서는 `adb reverse tcp:8088 tcp:8088`을 설정하고 `ANDROID_SERIAL=emulator-5554`를 추가한다. probe가 테스트 승인 서버의 임시 포트도 자동으로 reverse한다. 승인 전 시작 거부, FE·VAD 모델 로드, 합성 재생 완료·취소, pause/reset/reconnect/stop-start, 정지 상태의 native 승인 만료를 검증한다. Android에서는 만료된 마이크 foreground service가 종료되었는지도 확인한다.


`.github/workflows/audio-engine-mobile.yml`은 PR과 수동 실행에서 Web·Mobile·Desktop 설치 회귀 테스트를 별도 job으로 실행한다. 이 테스트는 로컬 SDK fixture를 사용하므로 비공개 저장소나 설치 토큰이 필요 없다. 같은 저장소의 PR과 수동 실행에서는 테스트용 engine artifact를 만든 뒤 SDK 전체 게이트·예제 타입/Jest·fresh Expo prebuild·실제 iOS Simulator/Android Emulator probe도 실행한다.

네이티브 검증에는 비공개 `tellus-ai/Tellus-audio-engine` 저장소를 읽을 수 있는 CI용 토큰이 필요하다. 예제 저장소의 **Settings → Secrets and variables → Actions → New repository secret**에서 `TELLUS_CI_REPOSITORY_TOKEN`을 등록한다. Fine-grained PAT를 사용할 경우 resource owner는 `tellus-ai`, 대상 저장소는 `Tellus-audio-engine`, repository permission은 **Contents: Read-only**로 설정하고 조직 승인이 필요하면 승인까지 완료한다. 기본 `GITHUB_TOKEN`은 예제 저장소에만 접근할 수 있으므로 대신 사용할 수 없다. 공개 SDK checkout에는 별도 토큰이 필요 없다. 토큰 등록 후 실패한 workflow를 다시 실행한다. 수동 실행에서는 `engine_ref`/`sdk_ref`로 검증할 revision을 지정한다.

`eas.json`은 로컬 검토용 Debug 개발 프로필을 준비하며 EAS 서명·배포는 수행하지 않는다.

## 로컬 캡처 음성 다운로드

**Start → Stop → Download Audio** 순서로 SDK가 캡처한 음성을 `tellus-recording-<timestamp>.ogg` 파일로 저장한다. 기존 SDK Opus 프레임을 Ogg 컨테이너에 담으므로 번역용 전송 설정은 유지한다.

저장 위치는 **Expo 개발 서버를 실행하는 Mac의 `~/download`**이며, 현재 Mac에서는 `/Users/lucas/download`이다. iOS·Android에서 JS 번들을 제공하는 Metro 서버에 파일을 전송하고, `metro.config.js`의 저장 middleware가 소문자 `download` 폴더를 생성해 저장한다. 서버 주소는 React Native `SourceCode`의 HTTP(S) 번들 URL 또는 Expo `hostUri`에서 얻는다. 완료 후 Mac의 실제 저장 경로를 표시한다. 기존 파일은 덮어쓰지 않는다.

이 기능은 로컬 Expo 개발 서버 연결이 필요하다. `metro.config.js` 변경 후에는 Metro를 재시작한다. 기기·시뮬레이터가 연결된 Mac에 저장하며, 서버 연결 또는 파일 저장에 실패하면 오류를 표시하고 재시도할 수 있게 녹음 데이터를 유지한다. 앱 내부나 기기의 Download 폴더로 우회 저장하지 않는다. 별도 다운로드 네이티브 모듈이나 저장소 권한은 사용하지 않는다.

Pause/Resume과 재연결 전후에 캡처한 음성은 한 파일에 포함한다. 캡처하지 않은 일시정지·연결 중단 시간은 생략하며, 오류 종료 후에도 이미 캡처한 음성은 저장할 수 있다. 음성은 메모리에 보관하다 다음 Start 또는 앱 종료 시 지우므로 새 세션 시작 전에 다운로드한다.
