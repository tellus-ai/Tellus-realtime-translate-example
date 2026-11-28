import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:tellus_flutter_example/src/realtime/result_parser.dart';
import 'package:tellus_flutter_example/src/realtime/types.dart';

const conversation = {'conversation_id': 'conversation-1'};
const times = {'speaker_id': '1', 'start_ms': 1352, 'end_ms': 6212};

ParsedSocketMessage parse(Map<String, Object?> message) => parseSocketMessage(jsonEncode(message));

/// The events of a result message, as records that `expect` can compare.
List<(ResultEventType, int orderSeq, String text, String? sourceLanguage, String? targetLanguage)> eventsOf(
  ParsedSocketMessage parsed,
) {
  return [
    for (final event in (parsed as ParsedResult).events)
      (event.eventType, event.orderSeq, event.text, event.sourceLanguage, event.targetLanguage),
  ];
}

(int? code, String? reason, String message, int? retryAfterMs) errorOf(ParsedSocketMessage parsed) {
  final error = (parsed as ParsedSystemError).error;
  return (error.code, error.reason, error.message, error.retryAfterMs);
}

final isInvalidPayload = isA<ParsedError>().having((parsed) => parsed.message, 'message', 'Invalid Result WebSocket payload.');

void main() {
  test('reads every utterance of a transcript.final, each with its own order_seq', () {
    final parsed = parse({
      'type': 'transcript.final',
      'data': {
        ...conversation,
        'utterances': [
          {'order_seq': 0, 'transcript': '다음 안건으로 넘어가겠습니다', 'source_language': 'ko-KR', ...times},
          {'order_seq': 1, 'transcript': " Let's check the budget first.", 'source_language': 'en-US', ...times},
        ],
      },
    });
    expect((parsed as ParsedResult).events.map((event) => event.conversationId), ['conversation-1', 'conversation-1']);
    expect(eventsOf(parsed), [
      (ResultEventType.transcriptFinal, 0, '다음 안건으로 넘어가겠습니다', 'ko-KR', null),
      (ResultEventType.transcriptFinal, 1, " Let's check the budget first.", 'en-US', null),
    ]);
  });

  test('reads a translation.final by the order_seq and target language of its item', () {
    final parsed = parse({
      'type': 'translation.final',
      'data': {
        ...conversation,
        'translations': [
          {'order_seq': 7, 'translation': 'Hello', 'source_language': 'ko-KR', 'target_language': 'en-US', ...times},
        ],
      },
    });
    expect(eventsOf(parsed), [(ResultEventType.translationFinal, 7, 'Hello', 'ko-KR', 'en-US')]);
  });

  test('shows the parts of a transcript.preview as one text under the open order_seq', () {
    final parsed = parse({
      'type': 'transcript.preview',
      'data': {
        ...conversation,
        'order_seq': 7,
        'utterances': [
          {'transcript': '네 그럼 다음 안건으로', 'source_language': 'ko-KR', ...times},
          {'transcript': " Let's check", 'source_language': 'en-US', ...times},
        ],
      },
    });
    expect(eventsOf(parsed), [(ResultEventType.transcriptPreview, 7, "네 그럼 다음 안건으로 Let's check", 'ko-KR', null)]);
  });

  test('groups a translation.preview by target language and skips the empty slots', () {
    final parsed = parse({
      'type': 'translation.preview',
      'data': {
        ...conversation,
        'order_seq': 7,
        'translations': [
          {'translation': 'Then the next item', 'source_language': 'ko-KR', 'target_language': 'en-US', ...times},
          {'translation': '', 'source_language': 'en-US', 'target_language': null, ...times},
          {'translation': '예산을 확인합시다', 'source_language': 'en-US', 'target_language': 'ko-KR', ...times},
          {'translation': 'please', 'source_language': 'ko-KR', 'target_language': 'en-US', ...times},
        ],
      },
    });
    expect(eventsOf(parsed), [
      (ResultEventType.translationPreview, 7, 'Then the next item please', 'ko-KR', 'en-US'),
      (ResultEventType.translationPreview, 7, '예산을 확인합시다', 'en-US', 'ko-KR'),
    ]);
  });

  test('keeps a language that the server does not know as null', () {
    final parsed = parse({
      'type': 'transcript.final',
      'data': {
        ...conversation,
        'utterances': [
          {'order_seq': 3, 'transcript': '...', 'source_language': null, ...times},
        ],
      },
    });
    expect(eventsOf(parsed), [(ResultEventType.transcriptFinal, 3, '...', null, null)]);
  });

  test('separates control messages and ignores the types it does not show', () {
    expect(parseSocketMessage('{"type":"conversation.ended","data":{}}'), isA<ParsedEnded>());
    for (final type in ['settings.updated', 'tts.completed', 'tts.skipped', 'a.type.added.later']) {
      expect(parse({'type': type, 'data': conversation}), isA<ParsedIgnored>());
    }
    // The shape of the unversioned routes is not a /v1 result.
    expect(parse({'type': 'result', 'data': {'event_type': 'transcript.final', 'text': '안녕'}}), isA<ParsedIgnored>());
    expect(parse({'type': 'participants.snapshot', 'data': {}}), isA<ParsedIgnored>());
    // The engine approval on /v1/audio, which the Audio SDK reads.
    expect(parse({'type': 'engine.authorized', 'version': 1, 'sequence': 1}), isA<ParsedIgnored>());
    expect(parseSocketMessage('[]'), isA<ParsedIgnored>());
  });

  test('reads the reason and message of a system.error', () {
    final parsed = parse({
      'type': 'system.error',
      'statusCode': '1008',
      'message': ['Conversation not found.', '대화를 찾을 수 없습니다.'],
      'data': {'reason': 'conversation_not_found'},
    });
    expect(errorOf(parsed), (1008, 'conversation_not_found', 'Conversation not found.', null));
  });

  test('reads retry_after_ms from the /v1/audio reconnect rate limit', () {
    (int?, int?) rateLimited(Object? retryAfterMs) {
      final (code, _, _, parsedRetryAfterMs) = errorOf(
        parse({
          'type': 'system.error',
          'statusCode': '1013',
          'message': ['Audio pipeline reconnect rate limit exceeded.'],
          'data': {'reason': 'audio_pipeline_activation_rate_limited', 'retry_after_ms': retryAfterMs},
        }),
      );
      return (code, parsedRetryAfterMs);
    }

    expect(rateLimited(800), (1013, 800));
    expect(rateLimited(0), (1013, 0));
    expect(rateLimited(-1), (1013, null));
    expect(rateLimited('800'), (1013, null));
  });

  test('keeps a system.error that has no reason, message, or status code', () {
    expect(errorOf(parseSocketMessage('{"type":"system.error"}')), (null, null, 'Realtime connection error.', null));
  });

  const invalid = <String, Map<String, Object?>>{
    'no item array': {'type': 'transcript.final', 'data': conversation},
    'no conversation_id': {
      'type': 'transcript.final',
      'data': {'utterances': []},
    },
    'a final item without order_seq': {
      'type': 'transcript.final',
      'data': {
        ...conversation,
        'utterances': [
          {'transcript': '안녕', 'source_language': 'ko-KR'},
        ],
      },
    },
    'a preview without order_seq': {
      'type': 'transcript.preview',
      'data': {
        ...conversation,
        'utterances': [
          {'transcript': '안녕', 'source_language': 'ko-KR'},
        ],
      },
    },
    'an item without its text': {
      'type': 'translation.final',
      'data': {
        ...conversation,
        'translations': [
          {'order_seq': 1, 'source_language': 'ko-KR', 'target_language': 'en-US'},
        ],
      },
    },
    'a negative order_seq': {
      'type': 'transcript.final',
      'data': {
        ...conversation,
        'utterances': [
          {'order_seq': -1, 'transcript': '안녕', 'source_language': 'ko-KR'},
        ],
      },
    },
  };
  for (final MapEntry(key: name, value: message) in invalid.entries) {
    test('reports a result with $name as an error', () {
      expect(parse(message), isInvalidPayload);
    });
  }

  test('reports invalid JSON as an error', () {
    expect(
      parseSocketMessage('not json'),
      isA<ParsedError>().having((parsed) => parsed.message, 'message', 'Result WebSocket returned invalid JSON.'),
    );
  });
}
