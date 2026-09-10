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

This section is a snapshot of the Realtime Speech API contract, copied from
Swagger, that both examples currently depend on. It records the contract the
examples were built against even if the server documentation changes later. It
does not describe every endpoint provided by the server.

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
- The REST endpoints below require `Authorization: Bearer <OAuth access token>`.
- According to the Swagger documentation as of 2026-09-10, the two WebSocket
  endpoints below do not require an Authorization header or a separate
  authentication frame. An active `conversation_id` is used to connect.

REST responses use the following common envelope.

```json
{
  "statusCode": "200",
  "message": ["ok"],
  "data": {}
}
```

### Client call sequence

1. Create a conversation with `POST /conversations`.
2. Configure languages and VAD with `POST /conversations/{conversation_id}/interpretation-settings`.
3. Connect the Result WebSocket and Audio WebSocket.
4. Send status JSON and PCM16 binary frames through the Audio WebSocket.
5. End the conversation with `POST /conversations/{conversation_id}/end`.

### REST endpoints

#### `POST /conversations`

The OpenAPI operation ID is `createConversation`, and the success status is `201`.

Request:

```json
{
  "max_concurrent_viewers": 10,
  "conversation_audio_mode": "single_speaker"
}
```

- `max_concurrent_viewers`: required integer, `1..10`
- `conversation_audio_mode`: `single_speaker` or `multi_speaker`; defaults to
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

The documented error statuses are `401`, `403`, `404`, `410`, `429`, and `503`.

#### `POST /conversations/{conversation_id}/interpretation-settings`

The OpenAPI operation ID is `saveInterpretationSettings`, and the success status
is `200`. The minimum payload currently sent by the Web and Mobile examples is
shown below.

```json
{
  "languages": ["ko-KR", "en-US"],
  "transcription": {
    "client_vad": true
  },
  "translation": {}
}
```

- `languages`: required BCP 47 language array with `1..2` items
- `transcription.client_vad`: when `true`, `audio.status.vad.event` is the speech
  boundary control signal; when `false`, the provider VAD is the boundary source.
- According to the Swagger description, a `translation` object is sent when two
  languages are configured. The current examples send an empty object, `{}`, to
  use the default translation settings.
- Although the OpenAPI JSON Schema lists only `languages` under `required`, the
  current examples follow the stricter Swagger description.
- Optional top-level fields are `domain_term_annotation_enabled`,
  `text_to_speech_enabled`, `transcription`, and `translation`.

Shape of `data` in a successful response:

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

The documented error statuses are `401`, `403`, `404`, `410`, `422`, `429`, and
`503`.

#### `POST /conversations/{conversation_id}/end`

The OpenAPI operation ID is `endConversation`, and the success status is `200`.
OpenAPI does not define a request body, and the current Web and Mobile
implementations do not send one.

Shape of `data` in a successful response:

```json
{
  "conversation_id": "conversation-1",
  "ended": true
}
```

The documented error statuses are `401`, `403`, `404`, `410`, `422`, `429`, and
`503`.

### Result WebSocket

Endpoint:

```text
wss://stgrtsapi.tellus.ai.kr/conversations/{conversation_id}/results
```

- The `conversation_id` path parameter is required.
- No separate ready message or history replay is sent after a successful connection.
- The server may send transcript/translation results, settings controls,
  terminology, TTS, and error messages as text JSON.
- The current examples directly handle only `result`, `conversation.ended`, and
  `system.error`; all other messages are ignored.

Shape of the Result message used by the current examples:

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
    "text": "Hello.",
    "source_language": "ko-KR",
    "target_language": "en-US",
    "start_at": null,
    "end_at": null,
    "participant": null
  }
}
```

`data.event_type` is one of the following four values.

- `transcript.preview`
- `transcript.final`
- `translation.preview`
- `translation.final`

The transcript and translation for the same utterance are associated using
`data.order_seq`, which increases monotonically across the conversation.
`order_seq` is not reset even if `stream_id` changes after a reconnection.

### Audio WebSocket

Endpoint used by the current examples:

```text
wss://stgrtsapi.tellus.ai.kr/audio?conversation_id={conversation_id}&audio_format=pcm16
```

- `conversation_id`: required query parameter
- `audio_format`: optional parameter, either `pcm16` or `opus`; the server
  defaults to `opus`, while the current examples explicitly use `pcm16`.
- The client sends PCM16 binary audio frames and `audio.status` text JSON to the
  server.
- No separate ready message is sent after a successful connection. If the
  connection is rejected, the server may send `system.error` and then close the
  socket.

Shape of `audio.status` documented by Swagger as of 2026-09-10:

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

- `status_seq` must increase monotonically. Older or duplicate values are ignored
  during boundary processing.
- `mic.state`: `disabled`, `idle`, `capturing`, `paused`, `permission_denied`, `error`
- `vad.event`: `speech_gate_opened` or `speech_gate_closed`; sent only when the
  gate actually transitions.
- When `client_vad: true`, `speech_gate_opened` re-enables the boundary and
  `speech_gate_closed` requests provider finalization.
- According to the Swagger description, `vad.level`, `vad.mode`, `vad.gate`, and
  `vad.is_speech` are observational. Their values alone do not change the server
  boundary.

WebSocket close code meanings:

| Code | Meaning |
| --- | --- |
| `1008` | Invalid request, authentication failure, permission denied, or missing resource |
| `1011` | Internal server error or temporary unavailability |
| `1013` | Too many requests or provider rate limit |

### Known Swagger/client differences

Check the differences below before changing the server or clients.

| Area | 2026-09-10 Swagger | Current Web/Mobile implementation |
| --- | --- | --- |
| Audio status cursor | `sample` | `boundary_sample` |
| Result end event | The Result endpoint description does not include a `conversation.ended` shape | Treats `conversation.ended` as the end signal |

The differences remaining in the table predate and are unrelated to the current
change to the end API body.

### Checking for server contract drift

Recalculate the hash of the current server documentation to compare it with the
snapshot above.

```bash
curl -sS https://stgrtsapi.tellus.ai.kr/openapi.json -o /tmp/tellus-openapi.json
shasum -a 256 /tmp/tellus-openapi.json
```

If the hash changes, compare at least the requests and responses for the three
REST endpoints above and the descriptions of the two WebSockets, then run the
type checks and tests for Web and Mobile.
