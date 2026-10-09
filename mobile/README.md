# 모바일 실시간 번역 예제

Expo 55 / React Native 0.83.9 개발 앱이다. `@tellus-ai/audio-sdk/react-native`가 OS 캡처, Rust DSP·FastEnhancer·Silero VAD·Opus 인코딩을 처리한다. 앱은 인코딩된 payload와 gate 이벤트만 `/audio`로 전달한다.

```sh
cp .env.example .env
npm install
npm run ios
# 또는 npm run android
```

현재 workspace의 SDK candidate는 `../../tellus-audio-sdk`에 연결된다. SDK installer가 플랫폼 binary와 `fe-s16.temc`, `fe-s48.temc`, `silero-vad.temc` 암호화 모델을 준비해야 한다. iOS는 SDK resource bundle, Android는 SDK assets를 native reader가 사용한다. SDK Expo plugin이 마이크 권한과 Android 지원 ABI를 자동 생성하고 autolinking으로 SDK를 연결한다. 고객 앱 코드는 React Native TypeScript로 유지하며 Swift·Kotlin·Podfile·Gradle을 직접 작성하지 않는다. Expo Go에는 SDK module이 없으므로 SDK가 포함된 개발 앱을 사용한다.

`.env`의 `API_KEY`에 OAuth access token을 설정하고 서로 다른 두 언어를 선택한다. `/audio` socket의 `attachEngineAuthorization.ready`가 permit과 모델 키를 적용한 뒤 마이크 권한을 요청하고 캡처를 시작한다. 새 socket마다 같은 capture를 재승인하며, 승인 폐기 시 OS 캡처와 대기 출력도 중단한다.

- 처리·전송: Opus, 16kHz mono, 20ms
- denoise: FastEnhancer 기본 활성화; `EXPO_PUBLIC_TELLUS_DENOISE=false`로 초기 비활성화 가능
- VAD: UI에서 세션 시작 전에 선택; 활성화하면 native Silero gate status를 해당 Opus payload보다 먼저 전송
- background·interruption·route 변경: 자동 캡처 재개 없이 중단하며 새 승인이 필요한 연결은 재승인 후 재개
- TTS: SDK `playback` 또는 `playbackEncoded`를 사용하면 OS 재생과 같은 PCM이 Rust AEC reference에 들어간다

서버 URL은 `EXPO_PUBLIC_REALTIME_SPEECH_HTTP_URL`, `EXPO_PUBLIC_REALTIME_SPEECH_WS_URL`, `EXPO_PUBLIC_APP_ORIGIN`으로 설정한다. access token은 앱 bundle에 포함되므로 partner secret이나 모델 content key를 넣지 않는다.

```sh
npm run type-check
npm test
```

네트워크 종료·재연결 정책은 [공통 API 문서](../README.md#api-contract)를 따른다. 마이크 payload의 `sampleCount`로 전송 cursor를 계산하고, `validSampleCount`는 마지막 padded 청크의 유효 범위를 나타낸다. Stop은 native flush를 승인된 socket에 전달한 뒤 최종 결과를 기다리고 Conversation을 종료한다.

공개 CI 서명 키를 신뢰하는 개발용 engine artifact와 테스트 CEK는 실제 배포에 사용하지 않는다.


Android host는 `app.json`과 SDK plugin으로 생성하는 로컬 산출물이므로 git에 저장하지 않는다. `npx expo prebuild --platform android --no-install`로 재생성할 수 있다. 기존 tracked iOS host는 유지하며 `prebuild --clean`으로 덮어쓰지 않는다. 새 CNG 앱에서는 [Expo 공식 흐름](https://docs.expo.dev/workflow/continuous-native-generation/)을 따라 두 플랫폼 모두 자동 생성할 수 있다.

실제 개발 앱 검증은 아래 명령을 사용한다. 앱을 설치·실행하고 localhost Metro를 시작한 뒤, 공개 CI 서명 키로 빌드한 테스트 artifact와 임시 CEK 경로를 지정한다. 마이크 payload를 저장하거나 송신하지 않고 metadata만 검사하며, 재생은 합성 WAV로 검사한다.

```sh
NODE_OPTIONS=--dns-result-order=ipv4first CI=1 npx expo start --dev-client --localhost --port 8088
TELLUS_ENGINE_TEST_LICENSE=1 METRO_URL=http://localhost:8088 node scripts/native-sdk-probe.mjs \
  /path/to/Tellus-audio-engine /path/to/sdk/vendor/ios/models /path/to/test-content-key.txt
```

Android에서는 `adb reverse tcp:8088 tcp:8088`을 설정하고 `ANDROID_SERIAL=emulator-5554`를 추가한다. probe가 테스트 승인 서버의 임시 포트도 자동으로 reverse한다. 승인 전 시작 거부, FE·VAD 모델 로드, 합성 재생 완료·취소, pause/reset/reconnect/stop-start, 정지 상태의 native 승인 만료를 검증한다. Android에서는 만료된 마이크 foreground service가 종료되었는지도 확인한다.


`.github/workflows/audio-engine-mobile.yml`은 같은 workflow의 선행 job에서 테스트용 engine artifact를 만든 뒤, SDK 전체 게이트·예제 타입/Jest·fresh Expo prebuild·실제 iOS Simulator/Android Emulator probe를 실행한다. private engine/SDK checkout에는 `TELLUS_CI_REPOSITORY_TOKEN`을 저장소 secret으로 설정하고, 수동 실행의 `engine_ref`/`sdk_ref`로 검증할 revision을 지정한다. 이 작업에서는 원격 CI를 실행하지 않는다. `eas.json`은 로컬 검토용 Debug 개발 프로필을 준비하며 EAS 서명·배포는 수행하지 않는다.
