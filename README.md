# Tellus realtime translation examples

Standalone realtime translation examples that can be copied and used independently.

- [`web/`](./web/README.md): Vite + React web example
- [`mobile/`](./mobile/README.md): Expo + React Native mobile example

Neither app depends on local Realtime Speech server code. Both connect directly to the staging server below.

- HTTP: `https://stgrtsapi.tellus.ai.kr`
- WebSocket: `wss://stgrtsapi.tellus.ai.kr`

Each app has its own packages and realtime communication implementation, with no imports between them.
Both apps read `API_KEY` from their local `.env` file and use it in the
`Authorization: Bearer <token>` header.

## API contract snapshot (2026-09-10)

이 절은 두 예제가 현재 의존하는 Realtime Speech API 계약을 Swagger에서 옮겨 둔
스냅샷이다. 서버 문서가 나중에 변경되더라도 예제가 어떤 계약을 기준으로 작성됐는지
확인하기 위한 것이며, 서버가 제공하는 모든 endpoint를 설명하지는 않는다.

| Item | Snapshot value |
| --- | --- |
| OpenAPI document | `https://stgrtsapi.tellus.ai.kr/openapi.json` |
| Swagger UI | `https://stgrtsapi.tellus.ai.kr/docs` |
| OpenAPI version | `3.1.0` |
| API title / version | `tellus-realtime-speech` / `0.1.0` |
| SHA-256 of the downloaded JSON | `1be80c377ee03fab8124aa94d21feb832fdcfad2ce605f525c3425ac094b4631` |

### Base URLs and authentication

- HTTP base URL: `https://stgrtsapi.tellus.ai.kr`
- WebSocket base URL: `wss://stgrtsapi.tellus.ai.kr`
- 아래 REST endpoint는 `Authorization: Bearer <OAuth access token>`을 요구한다.
- 아래 두 WebSocket endpoint는 2026-09-10 Swagger 설명 기준으로 Authorization
  header나 별도 인증 frame을 요구하지 않는다. 활성 `conversation_id`가 연결에 사용된다.

REST 응답은 공통으로 다음 envelope를 사용한다.

```json
{
  "statusCode": "200",
  "message": ["ok"],
  "data": {}
}
```

### Client call sequence

1. `POST /conversations`로 Conversation을 생성한다.
2. `POST /conversations/{conversation_id}/interpretation-settings`로 언어와 VAD를 설정한다.
3. Result WebSocket과 Audio WebSocket을 연결한다.
4. Audio WebSocket으로 상태 JSON과 PCM16 binary frame을 전송한다.
5. `POST /conversations/{conversation_id}/end`로 Conversation을 종료한다.

### REST endpoints

#### `POST /conversations`

OpenAPI operation ID는 `createConversation`이며 성공 status는 `201`이다.

Request:

```json
{
  "max_concurrent_viewers": 10,
  "conversation_audio_mode": "single_speaker"
}
```

- `max_concurrent_viewers`: 필수 integer, `1..10`
- `conversation_audio_mode`: `single_speaker` 또는 `multi_speaker`, 기본값
  `single_speaker`

Success response:

```json
{
  "statusCode": "201",
  "message": ["ok"],
  "data": {
    "conversation_id": "conversation-1",
    "conversation_audio_mode": "single_speaker",
    "max_concurrent_viewers": 10
  }
}
```

문서화된 error status는 `401`, `403`, `404`, `410`, `429`, `503`이다.

#### `POST /conversations/{conversation_id}/interpretation-settings`

OpenAPI operation ID는 `saveInterpretationSettings`이며 성공 status는 `200`이다.
현재 Web과 Mobile 예제가 보내는 최소 payload는 다음과 같다.

```json
{
  "languages": ["ko-KR", "en-US"],
  "transcription": {
    "client_vad": true
  },
  "translation": {}
}
```

- `languages`: 필수 BCP 47 language array, 항목 수 `1..2`
- `transcription.client_vad`: `true`이면 `audio.status.vad.event`가 speech
  boundary 제어 신호이며, `false`이면 provider VAD가 boundary source다.
- Swagger 설명에 따라 언어가 두 개면 `translation` object를 보낸다. 현재 예제는
  기본 translation 설정을 사용하기 위해 빈 object `{}`를 보낸다.
- OpenAPI JSON Schema의 `required`에는 `languages`만 포함되어 있지만, 현재 예제는
  더 엄격한 Swagger 설명을 따른다.
- 선택 가능한 최상위 필드는 `domain_term_annotation_enabled`,
  `text_to_speech_enabled`, `transcription`, `translation`이다.

Success response의 `data` shape:

```json
{
  "conversation_id": "conversation-1",
  "languages": ["ko-KR", "en-US"],
  "domain_term_annotation_enabled": false,
  "text_to_speech_enabled": false,
  "transcription": {
    "client_vad": true
  },
  "translation": {},
  "revision": 1
}
```

문서화된 error status는 `401`, `403`, `404`, `410`, `422`, `429`, `503`이다.

#### `POST /conversations/{conversation_id}/end`

OpenAPI operation ID는 `endConversation`이며 성공 status는 `200`이다. OpenAPI에는
request body가 정의되어 있지 않으며 현재 Web과 Mobile 구현도 body를 보내지 않는다.

Success response의 `data` shape:

```json
{
  "conversation_id": "conversation-1",
  "ended": true
}
```

문서화된 error status는 `401`, `403`, `404`, `410`, `422`, `429`, `503`이다.

### Result WebSocket

Endpoint:

```text
wss://stgrtsapi.tellus.ai.kr/conversations/{conversation_id}/results
```

- `conversation_id` path parameter가 필수다.
- 연결 성공 시 별도 ready message나 history replay가 없다.
- 서버는 transcript/translation result, settings control, terminology, TTS 및 error
  message를 text JSON으로 보낼 수 있다.
- 현재 예제는 `result`, `conversation.ended`, `system.error`만 직접 처리하며 그 외
  message는 무시한다.

현재 예제가 사용하는 Result message shape:

```json
{
  "type": "result",
  "statusCode": "200",
  "message": ["ok"],
  "data": {
    "conversation_id": "conversation-1",
    "stream_id": "conversation-1:speaker-1:1",
    "participant_id": "speaker-1",
    "event_type": "transcript.preview",
    "order_seq": 2,
    "text": "안녕하세요.",
    "source_language": "ko-KR",
    "target_language": "en-US",
    "start_at": null,
    "end_at": null,
    "participant": null
  }
}
```

`data.event_type`은 다음 네 값 중 하나다.

- `transcript.preview`
- `transcript.final`
- `translation.preview`
- `translation.final`

같은 발화의 transcript와 translation은 conversation 전체에서 단조 증가하는
`data.order_seq`로 묶는다. 재연결로 `stream_id`가 바뀌어도 `order_seq`는 초기화되지
않는다.

### Audio WebSocket

현재 예제가 사용하는 endpoint:

```text
wss://stgrtsapi.tellus.ai.kr/audio?conversation_id={conversation_id}&audio_format=pcm16
```

- `conversation_id`: 필수 query parameter
- `audio_format`: 선택 parameter, `pcm16` 또는 `opus`; 서버 기본값은 `opus`이고
  현재 예제는 명시적으로 `pcm16`을 사용한다.
- Client에서 Server로 PCM16 binary audio frame과 `audio.status` text JSON을 보낸다.
- 연결 성공 시 별도 ready message가 없다. 연결 거절 시 Server가 `system.error`를
  보낸 뒤 socket을 닫을 수 있다.

2026-09-10 Swagger가 문서화한 `audio.status` shape:

```json
{
  "type": "audio.status",
  "version": 1,
  "status_seq": 42,
  "sample": 32000,
  "mic": {
    "state": "capturing"
  },
  "vad": {
    "enabled": true,
    "level": "medium",
    "mode": "silero",
    "gate": "closed",
    "is_speech": false,
    "event": "speech_gate_closed"
  }
}
```

- `status_seq`는 단조 증가해야 하며 이전 값이나 중복 값은 boundary 처리에서
  무시된다.
- `mic.state`: `disabled`, `idle`, `capturing`, `paused`, `permission_denied`, `error`
- `vad.event`: `speech_gate_opened` 또는 `speech_gate_closed`; gate가 실제로
  전환될 때만 보낸다.
- `client_vad: true`일 때 `speech_gate_opened`는 boundary를 다시 활성화하고
  `speech_gate_closed`는 provider finalization을 요청한다.
- Swagger 설명상 `vad.level`, `vad.mode`, `vad.gate`, `vad.is_speech`는 관찰용이며
  그 값만으로 server boundary가 바뀌지 않는다.

WebSocket close code 의미:

| Code | Meaning |
| --- | --- |
| `1008` | 잘못된 요청, 인증 실패, 권한 거부 또는 없는 resource |
| `1011` | 내부 서버 오류 또는 일시적 사용 불가 |
| `1013` | 요청 과다 또는 provider rate limit |

### Known Swagger/client differences

서버나 클라이언트를 변경할 때 아래 차이를 먼저 확인해야 한다.

| Area | 2026-09-10 Swagger | Current Web/Mobile implementation |
| --- | --- | --- |
| Audio status cursor | `sample` | `boundary_sample` |
| Result end event | Result endpoint 설명에 `conversation.ended` shape가 없음 | `conversation.ended`를 종료 신호로 처리 |

표에 남은 차이는 이번 종료 API body 수정과 별개인 기존 상태다.

### Checking for server contract drift

현재 서버 문서의 hash를 다시 계산해 위 snapshot과 비교할 수 있다.

```bash
curl -sS https://stgrtsapi.tellus.ai.kr/openapi.json -o /tmp/tellus-openapi.json
shasum -a 256 /tmp/tellus-openapi.json
```

Hash가 바뀌면 최소한 위 세 REST endpoint의 request/response와 두 WebSocket 설명을
다시 대조한 뒤 Web과 Mobile의 type check 및 test를 실행한다.
