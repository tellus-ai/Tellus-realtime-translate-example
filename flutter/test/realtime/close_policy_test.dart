import 'package:flutter_test/flutter_test.dart';
import 'package:tellus_flutter_example/src/realtime/close_policy.dart';

SystemError systemError(int code, String reason, String message, [int? retryAfterMs]) {
  return SystemError(code: code, reason: reason, message: message, retryAfterMs: retryAfterMs);
}

CloseDecision decide(int code, {String reason = '', SystemError? lastError, int attempt = 0, double Function()? random}) {
  return decideSocketClose(code: code, reason: reason, lastError: lastError, attempt: attempt, random: random);
}

Matcher ended(String? reason) => isA<CloseEnded>().having((decision) => decision.reason, 'reason', reason);

Matcher fails(String? reason, String message, {required bool endConversation}) {
  return isA<CloseFail>()
      .having((decision) => decision.reason, 'reason', reason)
      .having((decision) => decision.message, 'message', message)
      .having((decision) => decision.endConversation, 'endConversation', endConversation);
}

Matcher reconnects(String? reason, int delayMs) {
  return isA<CloseReconnect>()
      .having((decision) => decision.reason, 'reason', reason)
      .having((decision) => decision.delayMs, 'delayMs', delayMs);
}

Matcher reconnectsAfter(int delayMs) => isA<CloseReconnect>().having((decision) => decision.delayMs, 'delayMs', delayMs);

void main() {
  group('decideSocketClose', () {
    test('treats 1000 as the end of the Conversation', () {
      expect(decide(1000, reason: 'conversation_ended'), ended('conversation_ended'));
      expect(decide(1000), ended(null));
    });

    for (final reason in ['conversation_ended', 'conversation_not_found']) {
      test('treats 1008 $reason as ended', () {
        expect(decide(1008, reason: reason), ended(reason));
      });
    }

    test('reads the reason from system.error when the close frame has none', () {
      final lastError = systemError(1008, 'conversation_ended', 'Conversation has already ended.');
      expect(decide(1008, lastError: lastError), ended('conversation_ended'));
    });

    for (final code in [1001, 1006]) {
      test('preserves the server authorization rejection when the socket reports $code', () {
        final lastError = systemError(1008, 'engine_authentication_invalid', 'engine_authentication_invalid');
        expect(
          decide(code, reason: 'Stream end encountered', lastError: lastError),
          fails(
            'engine_authentication_invalid',
            "Audio engine authorization was rejected (1008: engine_authentication_invalid). Check that the server supports this SDK's authorization request and model-key protocol.",
            endConversation: true,
          ),
        );
      });
    }

    test('preserves replacement semantics when the reported close code differs', () {
      final lastError = systemError(1008, 'audio_connection_replaced', 'Audio connection was replaced.');
      expect(
        decide(1001, reason: 'Stream end encountered', lastError: lastError),
        fails(
          'audio_connection_replaced',
          'Another device or tab took over the audio of this Conversation.',
          endConversation: false,
        ),
      );
    });

    test('stops without ending the Conversation when another connection replaced /audio', () {
      expect(
        decide(1008, reason: 'audio_connection_replaced'),
        fails(
          'audio_connection_replaced',
          'Another device or tab took over the audio of this Conversation.',
          endConversation: false,
        ),
      );
    });

    test('stops without ending the Conversation when another connection replaced Result', () {
      expect(
        decide(1008, reason: 'results_connection_replaced'),
        fails(
          'results_connection_replaced',
          'Another device or tab took over the results of this Conversation.',
          endConversation: false,
        ),
      );
    });

    for (final reason in ['API key expired', 'API key verification failed', '']) {
      test('stops after 4401 "$reason": reconnecting with the same key cannot succeed', () {
        expect(
          decide(4401, reason: reason, attempt: 2),
          fails(
            reason.isEmpty ? null : reason,
            'The server no longer accepts the API key. (${reason.isEmpty ? 4401 : reason})',
            endConversation: true,
          ),
        );
      });
    }

    const rejections = {
      'origin_not_allowed': 'Permission denied.',
      'auth_failed': 'Authentication failed.',
      'v1_settings_required': 'Settings were saved through another route.',
      'interpretation_settings_changed': 'Interpretation worker revision conflict.',
      'interpretation_settings_not_found': 'Interpretation settings were not found.',
      'invalid_audio_status': 'Invalid audio status message.',
      'a_reason_added_later': 'Invalid request.',
    };
    for (final MapEntry(key: reason, value: message) in rejections.entries) {
      test('does not reconnect after 1008 $reason', () {
        final lastError = systemError(1008, reason, message);
        expect(
          decide(1008, reason: reason, lastError: lastError, attempt: 3),
          fails(reason, '$message ($reason)', endConversation: true),
        );
      });
    }

    test('describes a 1008 close that carries neither a reason nor a system.error', () {
      expect(decide(1008), fails(null, 'The server refused the connection. (1008)', endConversation: true));
    });

    const temporary = [
      (1001, 'Stream end encountered'),
      (1006, ''),
      (1011, 'internal_error'),
      (1011, 'keepalive ping timeout'),
      (1013, 'result_send_failed'),
      (1013, 'temporarily_unavailable'),
      (1014, ''),
      (4000, 'a_code_added_later'),
    ];
    for (final (code, reason) in temporary) {
      test('reconnects with backoff after $code $reason', () {
        expect(decide(code, reason: reason), reconnects(reason.isEmpty ? null : reason, 1000));
        expect(decide(code, reason: reason, attempt: 2), reconnectsAfter(5000));
      });
    }

    test('waits at least retry_after_ms after the /v1/audio reconnect rate limit', () {
      const reason = 'audio_pipeline_activation_rate_limited';
      const message = 'Audio pipeline reconnect rate limit exceeded.';
      expect(decide(1013, reason: reason, lastError: systemError(1013, reason, message, 800)), reconnects(reason, 1000));
      final longer = systemError(1013, reason, message, 1700);
      expect(decide(1013, reason: reason, lastError: longer), reconnectsAfter(1700));
      expect(decide(1013, reason: reason, lastError: longer, attempt: 3), reconnectsAfter(10000));
    });

    test('preserves a server retry delay when the socket reports a stream end', () {
      const reason = 'audio_pipeline_activation_rate_limited';
      final lastError = systemError(1013, reason, 'Audio pipeline reconnect rate limit exceeded.', 3000);
      expect(decide(1001, reason: 'Stream end encountered', lastError: lastError), reconnects(reason, 3000));
    });

    test('spreads the first reconnect after a server restart, then backs off', () {
      expect(decide(1012, random: () => 0), reconnectsAfter(500));
      expect(decide(1012, random: () => 0.999), reconnectsAfter(1998));
      expect(decide(1012, attempt: 1, random: () => 0), reconnectsAfter(2000));
    });
  });

  group('reconnectDelayMs', () {
    test('waits 1, 2, 5, 10, and 30 seconds, then every 30 seconds', () {
      expect([0, 1, 2, 3, 4, 5, 20].map(reconnectDelayMs), [1000, 2000, 5000, 10000, 30000, 30000, 30000]);
    });
  });
}
