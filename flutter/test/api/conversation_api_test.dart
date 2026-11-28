import 'dart:async';
import 'dart:convert';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:tellus_flutter_example/src/api/access_tokens.dart';
import 'package:tellus_flutter_example/src/api/conversation_api.dart';
import 'package:tellus_flutter_example/src/api/http_client.dart';

const endpoints = RealtimeEndpoints(
  apiBaseUrl: 'https://example.test',
  websocketBaseUrl: 'wss://example.test',
  appOrigin: 'https://app.example.test',
);
// This app's own server holds the API key and adds it. The app sends only this header.
const exampleHeaders = {'Content-Type': 'application/json', 'X-Tellus-Example-Api': '1'};

enum Failure { network, noAnswer }

http.Response jsonResponse(int status, Object? body) => http.Response.bytes(utf8.encode(jsonEncode(body)), status);

void main() {
  group('conversation API', () {
    late List<http.Request> sent;

    /// A client that answers every request with [status] and [body].
    MockClient answering(int status, Object? body) {
      sent = [];
      return MockClient((request) async {
        sent.add(request);
        return jsonResponse(status, body);
      });
    }

    test('saves the two languages through the /v1 settings route, with client VAD off', () async {
      final client = answering(200, {'statusCode': '200', 'message': ['ok'], 'data': {}});
      await saveInterpretationSettings(endpoints, 'conversation-1', 'ko-KR', 'en-US', client: client);

      expect(sent.single.method, 'POST');
      expect('${sent.single.url}', 'https://example.test/v1/conversations/conversation-1/settings');
      expect(jsonDecode(sent.single.body), {
        'languages': ['ko-KR', 'en-US'],
        'transcription': {'client_vad': false},
      });
      // No credential: the example server adds the API key.
      expect(sent.single.headers, exampleHeaders);
    });

    test('creates a Conversation through the /v1 route without a body', () async {
      final client = answering(201, {'statusCode': '201', 'message': ['ok'], 'data': {'conversation_id': 'c1'}});
      expect(await createConversation(endpoints, client: client), 'c1');

      expect(sent.single.method, 'POST');
      expect('${sent.single.url}', 'https://example.test/v1/conversations');
      expect(sent.single.bodyBytes, isEmpty);
      expect(sent.single.headers, exampleHeaders);
    });

    test('asks the example server for an access token of one Conversation; the answer has no envelope', () async {
      final client = answering(201, {'access_token': 'tl_at_1', 'expires_at_ms': 1000});
      final issued = await issueAccessToken(endpoints, 'c1', client: client);

      expect((issued.token, issued.expiresAtMs), ('tl_at_1', 1000));
      expect('${sent.single.url}', 'https://example.test/v1/access-tokens');
      expect(jsonDecode(sent.single.body), {'session_kind': 'conversation', 'session_id': 'c1'});
      expect(sent.single.headers, exampleHeaders);
    });

    test('reports the detail of an access token error and rejects an answer without a token', () async {
      await expectLater(
        issueAccessToken(endpoints, 'c1', client: answering(410, {'detail': 'Session has already ended'})),
        throwsA(
          isA<RealtimeApiError>()
              .having((error) => error.message, 'message', 'Session has already ended')
              .having((error) => error.status, 'status', 410),
        ),
      );
      await expectLater(
        issueAccessToken(endpoints, 'c1', client: answering(201, {})),
        throwsA(
          isA<StateError>().having(
            (error) => error.message,
            'message',
            'Access token response is missing access_token or expires_at_ms.',
          ),
        ),
      );
    });

    test('reads an error message that is not ASCII, and falls back to the status', () async {
      await expectLater(
        createConversation(endpoints, client: answering(404, {'message': ['대화를 찾을 수 없습니다.']})),
        throwsA(isA<RealtimeApiError>().having((error) => '$error', 'text', '대화를 찾을 수 없습니다.')),
      );
      final plain = MockClient((_) async => http.Response('', 500));
      await expectLater(
        createConversation(endpoints, client: plain),
        throwsA(isA<RealtimeApiError>().having((error) => error.message, 'message', 'HTTP 500')),
      );
    });
  });

  group('WebSocket handshake', () {
    test('opens the /v1 routes and keeps every credential out of the URL', () {
      expect(buildResultWebSocketUrl(endpoints, 'a/b'), 'wss://example.test/v1/conversations/a%2Fb/results');
      expect(buildAudioWebSocketUrl(endpoints, 'a/b'), 'wss://example.test/v1/audio?conversation_id=a%2Fb&audio_format=opus');
    });

    test('adds after_order_seq to Result, including 0', () {
      expect(buildResultWebSocketUrl(endpoints, 'c1', 0), 'wss://example.test/v1/conversations/c1/results?after_order_seq=0');
      expect(buildResultWebSocketUrl(endpoints, 'c1', 12), 'wss://example.test/v1/conversations/c1/results?after_order_seq=12');
    });

    test('sends the access token in the Authorization header, next to the allowed Origin', () {
      expect(buildWebSocketHeaders(endpoints, ' tl_at_1 '), {
        'Origin': 'https://app.example.test',
        'Authorization': 'Bearer tl_at_1',
      });
    });

    // The Opus payload that is sent must match the decoder that the URL asks the server for.
    test('declares the Opus transport format of the SDK', () {
      final url = Uri.parse(buildAudioWebSocketUrl(endpoints, 'id with space'));
      expect(url.queryParameters, {'conversation_id': 'id with space', 'audio_format': 'opus'});
    });
  });

  group('conversation API retries', () {
    /// The next answers: a status, a `(status, body)` record, or a [Failure]. 200 once it is empty.
    late List<Object> replies;
    late List<String> requests;
    late MockClient client;

    setUp(() {
      replies = [];
      requests = [];
      client = MockClient((request) {
        requests.add('${request.method} ${request.url.path}');
        return switch (replies.isEmpty ? 200 : replies.removeAt(0)) {
          Failure.network => throw http.ClientException('Network request failed'),
          // A request that is never answered ends only when the caller stops waiting.
          Failure.noAnswer => Completer<http.Response>().future,
          (int status, Object? body) => Future.value(jsonResponse(status, body)),
          final reply => Future.value(jsonResponse(reply as int, {})),
        };
      });
    });

    /// Runs the retry waits and returns how the call settled.
    ({Object? value, Object? error}) settle<T>(FakeAsync async, Future<T> call) {
      var settled = false;
      Object? value;
      Object? error;
      call
          .then<void>((result) {
            value = result;
          }, onError: (Object failure) {
            error = failure;
          })
          .whenComplete(() => settled = true);
      async.flushTimers();
      expect(settled, isTrue);
      return (value: value, error: error);
    }

    void elapseAndCount(FakeAsync async, List<(int waitMs, int sent)> steps) {
      for (final (waitMs, sent) in steps) {
        async.elapse(Duration(milliseconds: waitMs));
        expect(requests, hasLength(sent), reason: 'after another $waitMs ms');
      }
    }

    group('endConversation', () {
      for (final status in [200, 410, 404]) {
        test('treats $status as ended', () => fakeAsync((async) {
          replies = [(status, {'message': ['Conversation has already ended.']})];
          expect(settle(async, endConversation(endpoints, 'c1', client: client)).error, isNull);
          expect(requests, ['POST /v1/conversations/c1/end']);
        }));
      }

      test('calls again after 503 and after a network failure, waiting 1, 2, and 5 seconds', () => fakeAsync((async) {
        replies = [503, Failure.network, 503, 200];
        var ended = false;
        endConversation(endpoints, 'c1', client: client).then((_) => ended = true);
        elapseAndCount(async, [(0, 1), (999, 1), (1, 2), (2000, 3), (4999, 3), (1, 4)]);
        expect(ended, isTrue);
      }));

      test('gives up after three retries and reports the server message', () => fakeAsync((async) {
        replies = List.filled(5, (503, {'message': ['Temporarily unavailable.']}), growable: true);
        final error = settle(async, endConversation(endpoints, 'c1', client: client)).error;
        expect(requests, hasLength(4));
        expect('$error', 'Temporarily unavailable.');
      }));

      test('calls again when a request got no answer within 15 seconds', () => fakeAsync((async) {
        replies = [Failure.noAnswer, 200];
        var ended = false;
        endConversation(endpoints, 'c1', client: client).then((_) => ended = true);
        elapseAndCount(async, [(0, 1), (14999, 1), (1, 1), (999, 1), (1, 2)]);
        expect(ended, isTrue);
        // The timeout of a request that was answered is cancelled.
        expect(async.pendingTimers, isEmpty);
      }));

      // The example server answers 502 or 504 when Tellus could not be reached or was too slow.
      for (final status in [502, 504]) {
        test('calls again after $status from the example server, as after no response', () => fakeAsync((async) {
          replies = [(status, {'message': ['The speech server did not answer in time.']}), 200];
          expect(settle(async, endConversation(endpoints, 'c1', client: client)).error, isNull);
          expect(requests, hasLength(2));
        }));
      }

      for (final status in [401, 403]) {
        test('does not retry $status', () => fakeAsync((async) {
          replies = [(status, {'message': ['Permission denied.']})];
          final error = settle(async, endConversation(endpoints, 'c1', client: client)).error;
          expect(requests, hasLength(1));
          expect('$error', 'Permission denied.');
        }));
      }
    });

    group('createConversation and saveInterpretationSettings', () {
      Future<void> saveSettings() => saveInterpretationSettings(endpoints, 'c1', 'ko-KR', 'en-US', client: client);

      test('retry 503', () => fakeAsync((async) {
        replies = [503, (200, {'conversation_id': 'c1'}), 503, 200];
        expect(settle(async, createConversation(endpoints, client: client)).value, 'c1');
        expect(settle(async, saveSettings()).error, isNull);
        expect(requests, [
          'POST /v1/conversations',
          'POST /v1/conversations',
          'POST /v1/conversations/c1/settings',
          'POST /v1/conversations/c1/settings',
        ]);
      }));

      // The Conversation may exist even though its response was lost; a second create would
      // leave one that nobody ends.
      test('do not retry a network failure', () => fakeAsync((async) {
        replies = [Failure.network, Failure.network];
        expect('${settle(async, createConversation(endpoints, client: client)).error}', 'Network request failed');
        expect('${settle(async, saveSettings()).error}', 'Network request failed');
        expect(requests, hasLength(2));
      }));

      // Tellus may have created the Conversation although the example server saw no answer.
      for (final status in [502, 504]) {
        test('do not retry $status from the example server', () => fakeAsync((async) {
          replies = List.filled(2, (status, {'message': ['The speech server could not be reached.']}), growable: true);
          expect('${settle(async, createConversation(endpoints, client: client)).error}', 'The speech server could not be reached.');
          expect('${settle(async, saveSettings()).error}', 'The speech server could not be reached.');
          expect(requests, hasLength(2));
        }));
      }

      test('fail after 15 seconds without an answer, and do not retry', () => fakeAsync((async) {
        replies = [Failure.noAnswer, Failure.noAnswer];
        Object? error;
        createConversation(endpoints, client: client).catchError((Object failure) {
          error = failure;
          return '';
        });
        async.elapse(const Duration(milliseconds: 14999));
        expect(error, isNull);
        expect(async.pendingTimers, hasLength(1));
        async.elapse(const Duration(milliseconds: 1));
        expect(error, isA<RealtimeApiError>().having((e) => (e.message, e.status), 'message and status', ('The request timed out.', null)));
        expect('${settle(async, saveSettings()).error}', 'The request timed out.');
        expect(requests, hasLength(2));
      }));
    });

    group('issueAccessToken', () {
      // Unlike a create request, issuing a token twice leaves nothing behind.
      final failures = <String, Object>{
        'a network failure': Failure.network,
        '504 from the example server': (504, {'message': ['The speech server did not answer in time.']}),
      };
      for (final MapEntry(key: name, value: failure) in failures.entries) {
        test('calls again after $name', () => fakeAsync((async) {
          replies = [failure, (201, {'access_token': 'tl_at_1', 'expires_at_ms': 1000})];
          final issued = settle(async, issueAccessToken(endpoints, 'c1', client: client)).value as IssuedAccessToken;
          expect(issued.token, 'tl_at_1');
          expect(requests, ['POST /v1/access-tokens', 'POST /v1/access-tokens']);
        }));
      }
    });

    group('ConversationAccessTokens', () {
      const lifetime = Duration(minutes: 15);
      final start = DateTime.utc(2026);

      /// The tokens and the server share the fake clock.
      (ConversationAccessTokens, Object Function(String token)) tokensAt(FakeAsync async) {
        DateTime now() => start.add(async.elapsed);
        return (
          ConversationAccessTokens(endpoints, 'c1', client: client, now: now),
          (token) => (201, {'access_token': token, 'expires_at_ms': now().add(lifetime).millisecondsSinceEpoch}),
        );
      }

      test('reuses a token until one minute before it expires, then issues the next', () => fakeAsync((async) {
        final (tokens, next) = tokensAt(async);
        replies = [next('first')];
        expect(settle(async, tokens.get()).value, 'first');
        async.elapse(lifetime - const Duration(milliseconds: 60001));
        expect(settle(async, tokens.get()).value, 'first');
        expect(requests, hasLength(1));

        async.elapse(const Duration(milliseconds: 1));
        replies = [next('second')];
        expect(settle(async, tokens.get()).value, 'second');
        expect(requests, hasLength(2));
      }));

      test('shares one request between callers that ask at the same time', () => fakeAsync((async) {
        final (tokens, next) = tokensAt(async);
        replies = [next('first')];
        expect(settle(async, Future.wait([tokens.get(), tokens.get()])).value, ['first', 'first']);
        expect(requests, hasLength(1));
      }));

      test('asks again after a failed request instead of keeping the failure', () => fakeAsync((async) {
        final (tokens, next) = tokensAt(async);
        replies = [(401, {'detail': 'Invalid API key'}), next('first')];
        expect('${settle(async, tokens.get()).error}', 'Invalid API key');
        expect(settle(async, tokens.get()).value, 'first');
      }));
    });
  });
}
