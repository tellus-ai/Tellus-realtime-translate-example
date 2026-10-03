# Tellus realtime translation examples

Standalone realtime translation examples that can be copied and used independently.

- [`web/`](./web/README.md): Vite + React web example
- [`mobile/`](./mobile/README.md): Expo + React Native mobile example
- [`desktop/`](./desktop/README.md): Electron desktop example using the Tellus native audio engine

None of the apps depend on local Realtime Speech server code. All of them connect directly to the staging server below.

- HTTP: `https://stgrtsapi.tellus.ai.kr`
- WebSocket: `wss://stgrtsapi.tellus.ai.kr`

Each app has its own packages and realtime communication implementation, with no imports between them.
Each app reads `API_KEY` from its local `.env` file and uses it in the
`Authorization: Bearer <token>` header.

## API contract

The examples follow the Realtime Speech API documented in Swagger. This section
summarizes that documentation; Swagger is the reference.

- Swagger UI: `https://stgrtsapi.tellus.ai.kr/docs`
- OpenAPI document: `https://stgrtsapi.tellus.ai.kr/openapi.json`

The **Integration Guide** at the top of the Swagger page covers one
Conversation from creation to end: the calls to make, what the server sends,
and what a client should do when a connection closes. The WebSocket routes are
described at the end of the Swagger description, because OpenAPI lists only
HTTP operations.

### Base URLs and authentication

- HTTP base URL: `https://stgrtsapi.tellus.ai.kr`
- WebSocket base URL: `wss://stgrtsapi.tellus.ai.kr`
- The REST endpoints require `Authorization: Bearer <OAuth access token>`.
  Creating a Conversation makes the authenticated user its creator; guest
  tokens are rejected. A missing, invalid, or expired token returns `401`:
  refresh the token and retry once.
- The browser/mobile WebSocket flow does not send an Authorization header or auth frame; the
  server confirms that the Conversation is active. The desktop native engine additionally sends
  `audio.authenticate` and `engine.renew` on `/audio` to obtain and renew its execution permit.
- If the web origin is not allowed, a WebSocket closes with `1008` and
  `Permission denied.` Ask Tellus to register your origin.

### Conversation flow

A Conversation uses three REST calls and two WebSockets. After a disconnect, a
client reopens only the WebSockets (steps 3 and 4).

```text
Client                                                    Tellus
1. POST /conversations ---------------------------------> 201 { conversation_id }
2. POST /conversations/{id}/interpretation-settings ----> 200 { revision }
3. WS   /conversations/{id}/results --------------------> participants.snapshot (first message)
4. WS   /audio?conversation_id={id}&audio_format=opus
        binary audio frames and audio.status -----------> (no ready message)
        <------------------------------------------------ result events on the Result WebSocket
5. POST /conversations/{id}/end ------------------------> 200 { ended: true }
        <------------------------------------------------ /audio closed
        <------------------------------------------------ conversation.ended, Result WebSocket closed (1000)
```

- Save interpretation settings (step 2) before opening `/audio`. Otherwise
  `/audio` closes with `1008` and `Interpretation settings were not found.`
- Open the Result WebSocket first and wait for `participants.snapshot` before
  opening `/audio`. The Result WebSocket does not resend results produced
  before it connected.
- Do not save interpretation settings again during a Conversation. Saving again
  does not change the running worker, and the next `/audio` connection can close
  with `1008` `worker_revision_conflict`. To change languages, create a new
  Conversation.
- The Result WebSocket is receive-only. Any message the client sends on it
  closes it with `1008`. There is no leave message; to leave, close both
  WebSockets.
- Closing WebSockets does not end a Conversation. Only
  `POST /conversations/{id}/end` ends it.

### REST endpoints

HTTP responses use a common envelope. In errors, `message[0]` is English and
`message[1]`, when present, is Korean.

```json
{"statusCode": "404", "message": ["Conversation not found.", "대화를 찾을 수 없습니다."], "data": {}}
```

#### `POST /conversations`

Create a Conversation. The operation ID is `createConversation`, and the
success status is `201`.

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

Shape of `data` in a successful response:

```json
{
  "conversation_id": "conversation-1",
  "conversation_audio_mode": "single_speaker",
  "max_concurrent_viewers": 10
}
```

| Status | Meaning |
| --- | --- |
| `400` | Invalid request body, for example a missing or out-of-range `max_concurrent_viewers`. Fix the request; do not retry. |
| `401` | The access token is missing, invalid, or expired. Refresh the token and retry once. |
| `403` | Guest tokens cannot create a Conversation. |
| `503` | Temporarily unavailable. Retry with backoff. |

#### `POST /conversations/{conversation_id}/interpretation-settings`

Save the Conversation's interpretation settings. Creator access is required.
The operation ID is `saveInterpretationSettings`, and the success status is
`200`.

Save once, before opening `/audio`; until settings exist, `/audio` closes with
`1008` `Interpretation settings were not found.` Each save increments
`revision`. Settings take effect when the Conversation's interpretation worker
starts, so saving again during a Conversation does not change a running worker.

Request:

```json
{
  "languages": ["ko-KR", "en-US"],
  "transcription": {
    "client_vad": true
  }
}
```

| Field | Required | Description |
| --- | --- | --- |
| `languages` | yes | Active BCP 47 languages, 1 or 2 unique values. One language means transcription only; two languages enable translation with server defaults. |
| `text_to_speech_enabled` | no | Generate TTS audio for final translations. Defaults to `false`. |
| `transcription.client_vad` | no | When `true`, the server uses `audio.status.vad.event` as the speech boundary control signal: `speech_gate_opened` re-arms the boundary and `speech_gate_closed` requests utterance finalization. When `false` (default), server-side VAD is the boundary source. |
| `transcription.audio_format` | no | `opus` (default) or `pcm_s16le`. |
| `transcription.sample_rate` | no | `16000`. |
| `transcription.num_channels` | no | `1`. |
| `transcription.speech_end_detection` | no | `max_delay_ms` (`500..3000`, default `2000`), `finalization_bias` (`-1.0..1.0`, default `-0.5`), `finalization_speed_level` (`0..3`, default `0`). |

Supported languages: `ko-KR`, `en-US`, `en-GB`, `en-AU`, `en-IN`, `ja-JP`,
`zh-CN`, `zh-TW`, `yue-HK`, `es-ES`, `es-MX`, `es-US`, `fr-FR`, `fr-CA`,
`de-DE`, `vi-VN`, `pl-PL`, `th-TH`, `ru-RU`, `it-IT`, `id-ID`, `fil-PH`.

Shape of `data` in a successful response:

```json
{
  "conversation_id": "conversation-1",
  "languages": ["ko-KR", "en-US"],
  "text_to_speech_enabled": false,
  "transcription": {
    "audio_format": "opus",
    "sample_rate": 16000,
    "num_channels": 1,
    "client_vad": true,
    "speech_end_detection": null
  },
  "revision": 1
}
```

| Status | Meaning |
| --- | --- |
| `400` | Invalid request body, unsupported language, or invalid transcription options. Fix the request; do not retry. |
| `401` | The access token is missing, invalid, or expired. Refresh the token and retry once. |
| `403` | The authenticated user is not the Conversation creator, or the token is a guest token. |
| `404` | The Conversation does not exist (or its state expired 24 hours after creation). |
| `410` | The Conversation has ended. |
| `412` | Another save changed the settings `revision` at the same time. Read the settings again, then save once more. |
| `503` | Temporarily unavailable. Retry with backoff. |

#### `POST /conversations/{conversation_id}/end`

End the Conversation. Creator access is required. The operation ID is
`endConversation`, and the success status is `200`. There is no request body.

The server closes `/audio`, then sends `conversation.ended` on the Result
WebSocket and closes it with `1000`. The HTTP response and
`conversation.ended` can arrive in either order; keep the Result WebSocket open
until `conversation.ended` arrives.

This call is not idempotent: a second call returns `410`, which means the
Conversation has already ended. Call it on every exit path. A Conversation that
is never ended stays open until its state expires 24 hours after creation, and
after that it can no longer be ended.

Shape of `data` in a successful response:

```json
{
  "conversation_id": "conversation-1",
  "ended": true
}
```

| Status | Meaning |
| --- | --- |
| `401` | The access token is missing, invalid, or expired. Refresh the token and retry once. |
| `403` | The authenticated user is not the Conversation creator. |
| `404` | The Conversation does not exist, or its state expired 24 hours after creation. It can no longer be ended. |
| `410` | The Conversation has already ended. Treat this as success. |
| `503` | Temporarily unavailable. The Conversation stays open, and new `/audio` connections may be rejected until this call succeeds. Call again. |

#### `GET /conversations/{conversation_id}/messages`

Return the Conversation's stored final results, ordered by `message_seq`.
Creator access is required. Previews are not stored.

Each page has at most `limit` messages (default and maximum `100`). Pass
`after_message_seq` to read messages after that value; while `has_more` is
`true`, call again with `next_after_message_seq`. Use this to fill finals
missed while the Result WebSocket was disconnected, and drop duplicates by
`order_seq`. History stays available after the Conversation ends, until its
state expires 24 hours after creation.

| Status | Meaning |
| --- | --- |
| `400` | Invalid `limit` or `after_message_seq`. |
| `401` | The access token is missing, invalid, or expired. Refresh the token and retry once. |
| `403` | The authenticated user is not the Conversation creator, or the token is a guest token. |
| `404` | The Conversation does not exist, or its state expired 24 hours after creation. |
| `503` | Temporarily unavailable. Retry with backoff. |

### Result WebSocket

Endpoint:

```text
wss://stgrtsapi.tellus.ai.kr/conversations/{conversation_id}/results
```

Receive transcripts, translations, presence, and the end of the Conversation.
Open this before `/audio`.

- Do not add query parameters; unexpected query parameters close the socket
  with `1008`.
- This WebSocket is receive-only; any text or binary message from the client
  closes it with `1008`. There is no leave message.
- The first message after the connection is accepted is
  `participants.snapshot`. Treat it as the ready signal and open `/audio`
  after it.
- The endpoint does not replay earlier results, including after a reconnect.
  Fetch stored finals with `GET /conversations/{conversation_id}/messages`;
  previews are not stored.
- The server sends `participants.snapshot`, `participant.joined` /
  `participant.left` presence events, `result` events, `interpretation_settings.updated`
  control events, `tts.completed` audio events, `conversation.ended`, and
  `system.error` before most error closes. The examples handle `result`,
  `conversation.ended`, and `system.error`.
- If a server write to this socket does not finish within 1 second, the server
  closes it with `1013` and no `system.error`. Reconnect with backoff and fill
  the gap from the History API.

Result message example:

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
    "target_language": "en-US"
  }
}
```

| Field | Description |
| --- | --- |
| `data.event_type` | `transcript.preview`, `transcript.final`, `translation.preview`, or `translation.final`. |
| `data.order_seq` | Conversation-global utterance order, allocated monotonically and never reused across audio reconnects or worker/process restarts. The same utterance keeps this value across transcript/translation preview and final events. |
| `data.stream_id` | Speaker uplink and pipeline epoch stream ID. |
| `data.start_at`, `data.end_at` | Audio timeline start and end times in milliseconds for final results; preview messages may omit them. |
| `data.participant` | Optional participant profile metadata. |

Client handling rules:

- Use only the `data.event_type` prefix to distinguish transcript from
  translation, and only its suffix to distinguish preview from final.
- De-duplicate transcripts by `data.order_seq` + `data.event_type`; include
  `data.target_language` for translations.
- Group the transcript and translation of the same utterance with
  `data.order_seq`; it is conversation-global and does not reset when
  `stream_id` changes.
- Treat any envelope whose top-level `type` is not `result` as control or error
  data.

When the Creator ends the Conversation, the server sends `conversation.ended`
and closes this socket with `1000`. Treat `conversation.ended` or `1000` as the
end of the Conversation and do not reconnect.

```json
{
  "type": "conversation.ended",
  "data": {
    "conversation_id": "conversation-1",
    "ended_by_user_id": "7",
    "ended_at": 1800000035000
  }
}
```

`system.error` is sent before an error close. `statusCode` is the WebSocket
close code, and `data` contains `reason` when the error has a stable reason
code; it may also contain `conversation_id` and `retry_after_ms`. Errors for
ended or unknown Conversations carry no `reason`.

```json
{
  "type": "system.error",
  "statusCode": "1013",
  "message": ["Audio pipeline reconnect rate limit exceeded."],
  "data": {
    "conversation_id": "conversation-1",
    "reason": "audio_pipeline_activation_rate_limited",
    "retry_after_ms": 800
  }
}
```

### Audio WebSocket

Endpoint:

```text
wss://stgrtsapi.tellus.ai.kr/audio?conversation_id={conversation_id}&audio_format={opus|pcm16}
```

Stream one speaker's audio into a Conversation. Save interpretation settings
and open the Result WebSocket first.

| Query parameter | Required | Default | Values |
| --- | --- | --- | --- |
| `conversation_id` | yes | - | - |
| `audio_format` | no | `opus` | `pcm16`, `opus` |

- The client sends binary audio frames in the negotiated `audio_format`,
  text JSON `audio.status` messages for microphone and client VAD state, and
  optional `audio.discontinuity` messages when captured audio was dropped.
- The server sends nothing on success: no ready message and no
  acknowledgement. It sends `system.error` before most error closes. Results
  arrive on the Result WebSocket.
- Binary audio may be the first message; no status bootstrap message is
  required.
- The examples send 16 kHz mono audio in 20 ms frames. Web sends Opus at
  64 kbps when WebCodecs `AudioEncoder` and `AudioData` are available, and
  PCM16 otherwise. Mobile sends PCM16. Desktop sends Opus at 64 kbps from the
  native audio engine.

Connection rules:

- Each connection replaces the speaker's previous `/audio` connection. Close
  the old socket yourself: on the same server instance it is not closed and its
  frames are ignored; on another instance it closes on its next message with
  `1008` `audio_pipeline_fenced` (binary) or `audio_status_fenced`
  (`audio.status`). A connection that loses a simultaneous race closes with
  `1008` `audio_pipeline_epoch_superseded`.
- Reconnects are limited to five in a row, then one per second, per speaker.
  Over the limit the socket closes with `1013`
  `audio_pipeline_activation_rate_limited` and `data.retry_after_ms`.
- Audio sent while disconnected is not replayed. On a new socket,
  `boundary_sample` restarts at 0: it counts 16 kHz samples from the first
  audio frame sent on that socket. With `client_vad` true, send
  `speech_gate_opened` again after reconnecting if the speaker is talking.
- Interpretation stops about 15 minutes after the last audio frame, without
  closing this socket or sending a message; audio sent later on the same socket
  produces no results. If no audio was sent for 10 minutes or longer,
  including pauses, reconnect `/audio` before sending again.
- When the Conversation ends, this socket closes with `1000`, closes on its next
  message with `1008` (`audio_pipeline_fenced`, `audio_status_fenced`, or
  `conversation_audio_ingress_closed`), or stays open, depending on server
  configuration. Use `conversation.ended` on the Result WebSocket as the end
  signal.
- `audio.discontinuity` is only logged. An invalid `audio.discontinuity`, or a
  text message with an unknown `type` or `version`, is ignored and does not
  close the socket.

#### `audio.status`

```json
{
  "type": "audio.status",
  "version": 1,
  "boundary_sample": 32000,
  "mic": { "state": "capturing" },
  "vad": {
    "enabled": true,
    "event": "speech_gate_closed"
  }
}
```

| Field | Description |
| --- | --- |
| `type` | Must be `audio.status`. |
| `version` | Must be `1`. |
| `status_seq` | Deprecated and optional. The server ignores this value and applies statuses in the order they arrive on the connection. |
| `boundary_sample` | Non-negative audio sample cursor where this status applies on the uplink timeline. `sample` is accepted as an alias. |
| `mic.state` | `disabled`, `idle`, `capturing`, `paused`, `permission_denied`, or `error`. |
| `vad.enabled` | `true` when the client VAD detector is enabled. A `speech_gate_closed` event requests utterance finalization only when this is `true`. |
| `vad.event` | Optional speech gate transition event, sent only on gate transitions; omit or null it for ordinary status updates. |

With `client_vad` true, `vad.event` is the speech boundary control signal.
`speech_gate_opened` (with `mic.state` `capturing`) re-arms the speech boundary
at that boundary sample, and `speech_gate_closed` (with `mic.state`
`capturing` and `vad.enabled` true) requests utterance finalization at that
boundary sample. Send each event only when the client speech gate actually
transitions.

| `data.reason` or message | Code | Meaning | Retry |
| --- | --- | --- | --- |
| `Interpretation settings were not found.` | `1008` | Settings were not saved before connecting. | After saving settings. |
| `Invalid audio status message.` | `1008` | An `audio.status` field is missing or invalid. | No; fix the message. |
| `malformed_audio_control_json` | `1008` | A text message is not a JSON object. | No; fix the message. |
| `invalid_audio_control_identity` | `1008` | A text message has no string `type` or positive integer `version`. | No; fix the message. |
| `audio_pipeline_fenced`, `audio_status_fenced` | `1008` | A newer connection replaced this socket, or the Conversation ended. | Up to 2 times, unless a newer socket is already open. |
| `audio_pipeline_epoch_superseded` | `1008` | A simultaneous connection for the same speaker won. | Up to 2 times, unless a newer socket is already open. |
| `conversation_audio_ingress_closed` | `1008` | The Conversation is being ended. | No; treat as ended. |
| `worker_revision_conflict` | `1008` | Settings were saved again while the earlier interpretation worker runs. | No; create a new Conversation. |
| `audio_pipeline_activation_rate_limited` | `1013` | Too many reconnects for this speaker. | After `data.retry_after_ms`. |
| `worker_capacity_exceeded`, `audio_uplink_dependency_unavailable`, `pipeline_epoch_allocation_failed` | `1013` | No worker capacity or a temporary storage failure. | Yes, with backoff. |
| `participant_audio_cursor_conflict`, `participant_audio_cursor_corrupt` | `1011` | Server-side audio state error. | Yes, with backoff; report the `conversation_id` if it repeats. |

### Close codes and recommended client behavior

The close frame carries no reason text, so `CloseEvent.reason` is empty. Keep
the last `system.error` from each socket and read `data.reason` and `message`
from it; attach a message handler to `/audio` as well. No `system.error`
precedes `1012`, a `1011` caused by a missing pong, a `1013` caused by a slow
Result client, or a `1006`.

| Code | When | Socket | Retry | Client action |
| --- | --- | --- | --- | --- |
| `1000` | The Conversation ended with `POST /end`. The Result WebSocket closes right after `conversation.ended`. | both | no | Show the Conversation as ended. Do not reconnect. |
| `1008` | The Conversation has ended or does not exist: `Conversation has already ended.`, `Conversation not found.` (including the 24-hour expiry). | both | no | Show the Conversation as ended. Create a new Conversation to continue. |
| `1008` | The web origin is not allowed: `Permission denied.` | both | no | Ask Tellus to register your origin. |
| `1008` | Invalid request: unexpected query parameter, invalid JSON or control identity on `/audio`, any message sent on the Result WebSocket, or `/audio` opened before settings were saved. | both | no | Fix the client request. |
| `1008` | This `/audio` socket was replaced or fenced: `audio_pipeline_fenced`, `audio_status_fenced`, `audio_pipeline_epoch_superseded`. | `/audio` | up to 2 times | If you already opened a newer `/audio`, ignore this close. Otherwise reconnect. If it keeps happening, another device or tab is using the same Conversation; stop and tell the user. |
| `1008` | Interpretation settings were saved again during the Conversation: `worker_revision_conflict`. | `/audio` | no | Create a new Conversation. |
| `1008` | The Conversation is being ended: `conversation_audio_ingress_closed`. | `/audio` | no | Treat the Conversation as ended. |
| `1011` | Internal server error (for example `Worker bootstrap failed.`), or no pong within 20 seconds of a ping. | both | yes | Back off and reconnect. |
| `1012` | Server restart or redeploy. | both | yes | Wait a random 0.5–2 seconds, reconnect, then back off. |
| `1013` | `/audio` reconnect rate limit: `audio_pipeline_activation_rate_limited` with `data.retry_after_ms`. | `/audio` | yes | Wait at least `retry_after_ms`, then reconnect. |
| `1013` | Temporarily unavailable or no capacity: `worker_capacity_exceeded`, `audio_uplink_dependency_unavailable`, `pipeline_epoch_allocation_failed`, or a message ending in `temporarily unavailable.` | both | yes | Back off and reconnect. |
| `1013` | The Result client is too slow: a server write did not finish within 1 second. | Result | yes | Back off and reconnect. Fill the gap from the History API. |
| `1006` | Seen by the client, not sent by the server: network loss, a stopped server process, or an unexpected server error. | both | yes | Back off and reconnect. Retry at once on the browser `online` event. |

Retry any other close code with backoff.

**Backoff.** Wait 1, 2, 5, 10, and 30 seconds, then every 30 seconds. Reset the
attempt count only after a connection stays open for 30 seconds, because the
server can close a socket right after accepting it. With this schedule `/audio`
reconnects stay under the server limit of five in a row, then one per second,
per speaker.

Depending on server configuration, `worker_revision_conflict`,
`worker_capacity_exceeded`, and `Worker bootstrap failed.` can also appear
without any close: the sockets stay open but no results arrive. The result
watchdog in [Network loss and server failures](#network-loss-and-server-failures)
covers this case.

### Reconnecting after a disconnect

The server accepts a new `/audio` connection for the same `conversation_id` as
the continuation of the previous one. `order_seq` keeps increasing across
reconnects.

1. Reopen only the socket that closed. If both closed, open the Result
   WebSocket first.
2. Remove the old socket's handlers and close it before opening the new one.
   Ignore a late close from the old socket, for example `1008`
   `audio_pipeline_fenced`.
3. On a new `/audio` socket, count `boundary_sample` from 0 again.
4. After the socket opens, send `audio.status` first (`mic.state` is
   `capturing` or `paused`), then audio. With `client_vad: true`, reset the
   client VAD; if the speaker is talking, send `speech_gate_opened` again,
   otherwise that utterance is not recognized.
5. Audio from the disconnected period is not processed later. Drop it, or keep
   a short buffer (for example the last 0.5 seconds) and send it right after
   reconnecting.
6. Results are not sent again. A result with the same `order_seq` and
   `event_type` (and `target_language` for translations) replaces the earlier
   one. To fill finals missed during the gap, call
   `GET /conversations/{id}/messages` without `after_message_seq`, follow
   `next_after_message_seq` while `has_more` is true, and drop duplicates by
   `order_seq`.

### Ending a Conversation

`conversation.ended` is sent only after `POST /conversations/{id}/end`
succeeds with the creator's token, including when another device, tab, or your
server ends the Conversation.

- Treat whichever comes first as the end: `conversation.ended`, a Result
  `1000`, or an `/audio` `1000`. Stop reconnecting and close `/audio` yourself.
  If an `/audio` `1008` comes first, the next reconnect ends with `1008`
  `Conversation has already ended.`; treat that as the end.
- Show the Conversation as ended, not as an error, and do not call `/end` again
  (it returns `410`).
- To end a Conversation yourself:
  1. Send `audio.status` with `mic.state` `paused` or `idle`. With
     `client_vad: true` and an open gate, send `speech_gate_closed` first.
  2. Wait briefly (for example 2 seconds) for the last final.
  3. Stop reconnecting, close `/audio`, and call `POST /end`. Call it again on
     `503`.
  4. Keep the Result WebSocket open until `conversation.ended` arrives. The
     HTTP `200` and `conversation.ended` can arrive in either order.

### Time limits and automatic stops

There is no maximum Conversation length, and the server never ends a
Conversation on its own.

| Limit | Value | When it passes | Recommendation |
| --- | --- | --- | --- |
| Conversation state retention | 24 hours after creation. Activity does not extend it. | New connections, settings, the History API, and `/end` are rejected with `404` or `1008` `Conversation not found.` Open sockets stay open, but cannot reconnect after they close. | Create a new Conversation per session and end it within 24 hours. |
| No audio | About 15 minutes after the last audio frame. | Interpretation stops silently. Sockets stay open and no message is sent, but audio sent afterwards produces no results. | If no audio was sent for 10 minutes or longer (including pauses), reconnect `/audio` before sending again. |
| WebSocket ping | Every 25 seconds; the server waits 20 seconds for the pong. | The server closes the socket with `1011`. | Browsers answer pings automatically. Do not send application-level ping messages. |
| `/audio` reconnects | Five in a row, then one per second, per speaker. | `1013` `audio_pipeline_activation_rate_limited` with `retry_after_ms`. | Use the backoff above. |
| Result write | 1 second per server write. | The Result WebSocket closes with `1013`. | Keep the Result message handler fast. |

- The server never closes a socket because no audio arrives. As long as pings
  are answered, both WebSockets stay open.
- The 15-minute rule counts audio frames only. Silent frames count as audio, so
  short gaps alone do not stop interpretation.
- A Conversation ends only with `POST /end`. If it is never called, the
  Conversation stays open, and after 24 hours `/end` also returns `404`, so it
  can no longer be ended or cleaned up. Call `/end` on every exit path,
  including app shutdown and fatal errors.

### Network loss and server failures

The Conversation and `order_seq` are kept in server storage. Within 24 hours of
creation, a client that reconnects with the same `conversation_id` continues
the Conversation after a network drop or a server restart.

**Detecting a broken connection**

- The server pings every 25 seconds, but browsers answer pings without
  notifying the app.
- On `/audio`, watch `bufferedAmount`. If unsent audio stays above 2 seconds
  (64 KB of PCM16) for more than 5 seconds, close the socket and reconnect.
- The Result WebSocket is silent while nobody speaks. Silence alone does not
  mean the socket is broken.
- On the browser `offline` event, wait. On `online`, reconnect at once instead
  of waiting for the backoff.
- Treat a connection attempt that does not open within 10 seconds as failed and
  move to the next backoff step.

**Results stop while the sockets stay open.** If interpretation stops or the
Result WebSocket silently breaks, the sockets can stay open with no results.
This happens after 15 minutes without audio, and also after temporary failures
in the speech engine or server storage, or because of server configuration.
The server sends no close or `system.error` in these cases, so add this
watchdog:

- If the speaker is talking (the client VAD reports speech or the input level
  is high) and no result, including `transcript.preview`, arrives for 20
  seconds, reconnect the Result WebSocket and then `/audio`.
- If results still do not arrive, try twice more at 20-second intervals. Then
  tell the user and report the `conversation_id` and the time to Tellus.

**Retrying and giving up**

- Use the backoff above.
- While retrying, show a neutral message such as "The realtime connection is
  unstable; reconnecting." A close code alone does not tell whether the user's
  network, a CDN, or the server caused the problem.
- If you cap automatic retries, let the user choose between trying again and
  ending when the cap is reached. If the user chooses to end, call `POST /end`.
