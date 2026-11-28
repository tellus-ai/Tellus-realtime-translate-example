import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:tellus_audio_sdk/tellus_audio_sdk.dart';
import 'package:tellus_flutter_example/src/api/conversation_api.dart';
import 'package:tellus_flutter_example/src/audio/native_microphone.dart';
import 'package:tellus_flutter_example/src/realtime/realtime_socket.dart';
import 'package:tellus_flutter_example/src/realtime/realtime_translation_session.dart';
import 'package:tellus_flutter_example/src/realtime/types.dart';

const endpoints = RealtimeEndpoints(
  apiBaseUrl: 'https://example.test',
  websocketBaseUrl: 'wss://example.test',
  appOrigin: 'https://app.example.test',
);
const input = StartConversationInput(sourceLanguage: 'ko-KR', targetLanguage: 'en-US');
const endPath = '/v1/conversations/conversation-1/end';
const settingsPath = '/v1/conversations/conversation-1/settings';
const tokenPath = '/v1/access-tokens';
const tokenLifetime = Duration(minutes: 15);
const oneMs = Duration(milliseconds: 1);
const rateLimited = 'audio_pipeline_activation_rate_limited';

const open = ConnectionStatus.open;
const closed = ConnectionStatus.closed;

/// Answers of the fake server that are not an HTTP status.
enum Reply {
  networkFailure,
  noAnswer,

  /// A 201 whose body has no token.
  malformedToken,
}

class FakeMicrophone implements MicrophoneRecorder {
  @override
  bool audioSdkReady = true;
  @override
  bool denoiseEnabled = true;

  /// The capture was started and has not been stopped. A pause does not change this.
  bool started = false;
  bool capturing = false;

  Object? prepareError;
  Object? resumeError;

  /// The next denoise change fails with this.
  Object? denoiseError;

  /// The first engine approval fails with this.
  Object? authorizationError;

  /// Packets that the capture still delivers while it stops.
  int lastPackets = 0;

  /// A start, an engine approval and a pause finish only when these complete.
  Future<void> startGate = Future.value();
  Future<void> authorizationGate = Future.value();
  Future<void> pauseGate = Future.value();

  /// Each socket that was given to the engine approval, and whether it was open at that moment.
  final authorizations = <(EngineAuthorizationSocket, bool)>[];

  /// The token that the last engine approval sent on `/v1/audio`, and how it gets the next one.
  String? authorizedWith;
  Future<String> Function()? getAccessToken;

  void Function(AudioChunk chunk)? _onFrame;
  void Function(Object error)? _onError;
  void Function(Object error)? _onAuthorizationError;
  int _sequence = 0;

  @override
  Future<bool> setDenoiseEnabled(bool enabled) async {
    final error = denoiseError;
    denoiseError = null;
    if (error != null) throw error;
    return denoiseEnabled = enabled;
  }

  @override
  Future<void> prepare() async {
    if (prepareError case final error?) throw error;
  }

  @override
  Future<void> authorize(
    EngineAuthorizationSocket socket,
    String conversationId,
    Future<String> Function() getAccessToken,
    void Function(Object error) onError,
  ) async {
    authorizations.add((socket, socket.isOpen));
    this.getAccessToken = getAccessToken;
    _onAuthorizationError = onError;
    authorizedWith = await getAccessToken();
    await authorizationGate;
    if (authorizationError case final error?) throw error;
  }

  @override
  void releaseAuthorization() => capturing = false;

  @override
  Future<void> start(void Function(AudioChunk chunk) onFrame, void Function(Object error) onError) async {
    await startGate;
    _onFrame = onFrame;
    _onError = onError;
    started = true;
    capturing = true;
  }

  @override
  Future<void> pause() async {
    capturing = false;
    await pauseGate;
  }

  @override
  Future<void> resume() async {
    if (resumeError case final error?) throw error;
    capturing = true;
  }

  @override
  Future<void> stop() async {
    for (; lastPackets > 0; lastPackets--) {
      emit();
    }
    _onFrame = null;
    started = false;
    capturing = false;
  }

  /// The capture delivers one 20 ms Opus packet.
  void emit() {
    _onFrame?.call(
      AudioChunk(
        data: Uint8List(30),
        codec: 'opus',
        sampleRate: 16000,
        sample: 0,
        sampleCount: 320,
        validSampleCount: 320,
        timestamp: 0,
        rms: 0,
        sequence: _sequence++,
      ),
    );
  }

  /// The capture reports an error.
  void fail(Object error) => _onError?.call(error);

  /// The Audio SDK reports that an approved capture lost its approval.
  void loseAuthorization(Object error) => _onAuthorizationError?.call(error);
}

class FakeSocket extends RealtimeSocket {
  FakeSocket(this.url, this.headers, this._timeline)
    : kind = url.contains('/v1/audio?') ? SocketKind.audio : SocketKind.result;

  final String url;
  final Map<String, String> headers;
  final SocketKind kind;
  final List<String> _timeline;

  /// What the client sent: a `String` for a text frame, bytes for an audio frame.
  final sent = <Object>[];
  bool closed = false;
  bool _open = false;
  final _messages = StreamController<String>.broadcast();
  final _done = Completer<void>();

  @override
  bool get isOpen => _open;

  @override
  Stream<String> get messages => _messages.stream;

  @override
  Future<void> get done => _done.future;

  @override
  void send(String text) {
    sent.add(text);
    _timeline.add(describe(text));
  }

  @override
  void sendBytes(List<int> data) {
    sent.add(data);
    _timeline.add(describe(data));
  }

  @override
  void close() {
    if (closed) return;
    _end();
    _timeline.add('${kind.name} close');
  }

  /// The server accepts the connection. Neither socket sends a ready message.
  void open() {
    _open = true;
    onOpen?.call();
  }

  void receive(Map<String, Object?> message) {
    final text = jsonEncode(message);
    _messages.add(text);
    onMessage?.call(text);
  }

  /// A close that the client did not start.
  void serverClose(int code, [String reason = '']) {
    _end();
    onClose?.call(code, reason);
  }

  void _end() {
    _open = false;
    closed = true;
    if (!_done.isCompleted) _done.complete();
  }

  bool get detached => onOpen == null && onMessage == null && onClose == null && onError == null;

  List<Map<String, dynamic>> get statuses => [
    for (final item in sent)
      if (item is String) jsonDecode(item) as Map<String, dynamic>,
  ];

  static String describe(Object frame) {
    return frame is String ? 'audio.status ${(jsonDecode(frame) as Map)['mic']['state']}' : 'audio frame';
  }
}

http.Response plainJson(int status, Object? body) => http.Response.bytes(utf8.encode(jsonEncode(body)), status);

/// An answer in the envelope of the REST API.
http.Response envelope(int status, [Object? data = const <String, Object?>{}, String message = 'ok']) {
  return plainJson(status, {
    'statusCode': '$status',
    'message': [message],
    'data': data,
  });
}

Map<String, Object?> systemError(int code, String reason, String message, [Map<String, Object?> data = const {}]) {
  return {
    'type': 'system.error',
    'statusCode': '$code',
    'message': [message],
    'data': {'reason': reason, ...data},
  };
}

/// A result message with one item. A preview carries `order_seq` in `data`, a final in the item.
Map<String, Object?> result(String eventType, int orderSeq, String text, [String? targetLanguage]) {
  final isTranscript = eventType.startsWith('transcript.');
  final isFinal = eventType.endsWith('.final');
  return {
    'type': eventType,
    'data': {
      'conversation_id': 'conversation-1',
      if (!isFinal) 'order_seq': orderSeq,
      isTranscript ? 'utterances' : 'translations': [
        {
          if (isFinal) 'order_seq': orderSeq,
          isTranscript ? 'transcript' : 'translation': text,
          'source_language': 'ko-KR',
          if (!isTranscript) 'target_language': targetLanguage,
          'speaker_id': '1',
          'start_ms': 0,
          'end_ms': 480,
        },
      ],
    },
  };
}

/// The audio packets of an Ogg file: every page after the two header pages of a stream.
int recordedPacketCount(Uint8List data) {
  var offset = 0;
  var packets = 0;
  while (offset < data.length) {
    final segments = data[offset + 26];
    final size = data.sublist(offset + 27, offset + 27 + segments).fold<int>(0, (sum, value) => sum + value);
    if (ByteData.sublistView(data, offset).getUint32(18, Endian.little) >= 2) packets++;
    offset += 27 + segments + size;
  }
  return packets;
}

/// One test: a session, the fake server it talks to, and the fake clock.
class Harness {
  Harness(this.async) {
    session = sessionWith(endpoints);
  }

  final FakeAsync async;
  final microphone = FakeMicrophone();
  late final RealtimeTranslationSession session;

  /// What the client sent, closed, and requested, in the order it happened.
  final timeline = <String>[];
  final requests = <String>[];
  final httpRequests = <http.Request>[];
  final sockets = <FakeSocket>[];

  /// What the server does with a new connection. Tests replace it to refuse or stall one.
  void Function(FakeSocket socket) onConnect = (socket) => socket.open();

  /// Statuses for the next `POST /end` calls, or [Reply.noAnswer]; 200 once the list is empty.
  final endStatuses = <Object>[];

  /// `POST /end` is answered only when this completes.
  Future<void> endGate = Future.value();

  /// Whether a successful `POST /end` is followed by `conversation.ended` and 1000 on Result.
  bool sendsEnded = true;
  int settingsStatus = 200;

  /// Answers for the next `POST /v1/access-tokens` calls; a new token once the list is empty.
  final tokenReplies = <Object>[];
  int tokensIssued = 0;

  DateTime now() => DateTime.utc(2026).add(async.elapsed);

  RealtimeTranslationSession sessionWith(RealtimeEndpoints endpoints) {
    return RealtimeTranslationSession(
      endpoints,
      microphone,
      httpClient: MockClient(_answer),
      connectSocket: (url, headers) {
        final socket = FakeSocket(url, headers, timeline);
        sockets.add(socket);
        // Like a real connection, it opens after the caller has attached its handlers.
        scheduleMicrotask(() => onConnect(socket));
        return socket;
      },
      now: now,
    );
  }

  Future<http.Response> _answer(http.Request request) async {
    final path = request.url.path;
    requests.add('${request.method} $path');
    timeline.add('${request.method} $path');
    httpRequests.add(request);
    if (path == '/v1/conversations') return envelope(201, {'conversation_id': 'conversation-1'});
    if (path == tokenPath) {
      final reply = tokenReplies.isEmpty ? 201 : tokenReplies.removeAt(0);
      if (reply == Reply.networkFailure) throw http.ClientException('Network request failed');
      if (reply == Reply.malformedToken) return plainJson(201, {});
      // This route answers without the common envelope.
      if (reply != 201) return plainJson(reply as int, {'detail': 'Token refused with $reply.'});
      return plainJson(201, {
        'access_token': 'token-${tokensIssued += 1}',
        'expires_at_ms': now().add(tokenLifetime).millisecondsSinceEpoch,
      });
    }
    if (path == settingsPath && settingsStatus != 200) return envelope(settingsStatus, null, 'Permission denied.');
    if (path == endPath) {
      final status = endStatuses.isEmpty ? 200 : endStatuses.removeAt(0);
      // A request that is never answered ends only when the client stops waiting.
      if (status == Reply.noAnswer) return Completer<http.Response>().future;
      await endGate;
      if (status == 503) return envelope(503, null, 'Temporarily unavailable.');
      if (status != 200) return envelope(status as int, null, 'Conversation has already ended.');
      if (sendsEnded) {
        for (final socket in sockets.where((socket) => socket.isOpen).toList()) {
          if (socket.kind == SocketKind.result) socket.receive({'type': 'conversation.ended', 'data': {}});
          socket.serverClose(1000, 'conversation_ended');
        }
      }
    }
    return envelope(200);
  }

  /// Runs everything that is ready to run without moving the clock.
  void flush() => async.elapse(Duration.zero);

  void elapse(Duration duration) => async.elapse(duration);

  /// Starts the session and lets the start run as far as it gets without the clock.
  void start() {
    session.start(input);
    flush();
  }

  /// Runs [operation] as far as it gets without the clock. Returns whether it has completed.
  bool run(Future<void> operation) {
    final completed = completion(operation);
    flush();
    return completed();
  }

  /// A function that tells whether [operation] has completed.
  bool Function() completion(Future<void> operation) {
    var completed = false;
    operation.whenComplete(() => completed = true);
    return () => completed;
  }

  /// The value of a future that completes without the clock.
  T valueOf<T>(Future<T> future) {
    late T value;
    future.then((result) => value = result);
    flush();
    return value;
  }

  /// Checks that the next socket is opened exactly [delay] from now, and returns it.
  FakeSocket reopenedAfter(Duration delay) {
    final count = sockets.length;
    async.elapse(delay - oneMs);
    expect(sockets, hasLength(count));
    async.elapse(oneMs);
    expect(sockets.length, greaterThan(count));
    return sockets.last;
  }

  FakeSocket get resultSocket => sockets[0];
  FakeSocket get audioSocket => sockets[1];
  SessionSnapshot get snapshot => session.snapshot;

  /// The parts of the snapshot that most tests compare.
  (SessionPhase, String? error) get state => (snapshot.phase, snapshot.error);
  (ConnectionStatus result, ConnectionStatus audio) get connections => (snapshot.resultConnection, snapshot.audioConnection);

  /// Each row as `(order_seq, source text, English translation)`.
  List<(int, String?, String?)> get rows => [
    for (final row in snapshot.rows) (row.orderSeq, row.source?.text, row.translations['en-US']?.text),
  ];

  List<String> get endRequests => requests.where((request) => request == 'POST $endPath').toList();
  List<String> get tokenRequests => requests.where((request) => request == 'POST $tokenPath').toList();
  List<String> get socketKinds => [for (final socket in sockets) socket.kind.name];
}

void sessionTest(String description, void Function(Harness h) body) {
  test(description, () => fakeAsync((async) => body(Harness(async))));
}

void main() {
  group('start', () {
    sessionTest('creates the Conversation, saves the settings and gets a token, then opens both sockets with it', (h) {
      h.start();

      expect(h.requests, ['POST /v1/conversations', 'POST $settingsPath', 'POST $tokenPath']);
      // The app holds no API key: its server adds it. The header only shows that this app sent the request.
      for (final request in h.httpRequests) {
        expect(request.headers, {'Content-Type': 'application/json', 'X-Tellus-Example-Api': '1'});
      }
      expect(jsonDecode(h.httpRequests[1].body), {
        'languages': ['ko-KR', 'en-US'],
        'transcription': {'client_vad': false},
      });
      expect(jsonDecode(h.httpRequests[2].body), {'session_kind': 'conversation', 'session_id': 'conversation-1'});

      // The token goes in a header, so no credential is in a URL.
      expect(h.sockets.map((socket) => socket.url), [
        'wss://example.test/v1/conversations/conversation-1/results',
        'wss://example.test/v1/audio?conversation_id=conversation-1&audio_format=opus',
      ]);
      for (final socket in h.sockets) {
        expect(socket.headers, {'Origin': 'https://app.example.test', 'Authorization': 'Bearer token-1'});
      }
      expect(h.state, (SessionPhase.recording, null));
      expect(h.connections, (open, open));
      expect(h.snapshot.conversationId, 'conversation-1');
      expect(h.snapshot.audioSdkReady, isTrue);
      expect(h.microphone.capturing, isTrue);
    });

    sessionTest('sends the capturing status first, then each Opus packet of the microphone as one binary frame', (h) {
      h.start();
      h.microphone.emit();
      h.microphone.emit();

      expect(h.audioSocket.sent.map(FakeSocket.describe), ['audio.status capturing', 'audio frame', 'audio frame']);
      expect(h.audioSocket.statuses.single, {
        'type': 'audio.status',
        'version': 1,
        'status_seq': 1,
        'boundary_sample': 0,
        'mic': {'state': 'capturing'},
        'vad': {'enabled': false},
      });
      expect(h.audioSocket.sent[1], hasLength(30));
      expect(h.resultSocket.sent, isEmpty);
    });

    // A capture that started when the socket opened would record before the engine has its
    // permit and model keys.
    sessionTest('starts the microphone only after the engine approval on the open /v1/audio socket', (h) {
      final approval = Completer<void>();
      h.microphone.authorizationGate = approval.future;
      h.start();

      expect(h.connections, (open, open));
      expect(h.snapshot.phase, SessionPhase.connecting);
      expect(h.microphone.capturing, isFalse);
      expect(h.microphone.authorizations, [(h.audioSocket, true)]);
      // The engine approval uses the access token too. The app has no API key.
      expect(h.microphone.authorizedWith, 'token-1');

      approval.complete();
      h.flush();
      expect(h.snapshot.phase, SessionPhase.recording);
      expect(h.microphone.capturing, isTrue);
    });

    sessionTest('rejects input that cannot start a Conversation, without a request', (h) {
      Object? failureOf(Future<void> start) {
        Object? failure;
        start.catchError((Object error) {
          failure = error;
        });
        h.flush();
        return failure;
      }

      const same = StartConversationInput(sourceLanguage: 'ko-KR', targetLanguage: 'ko-KR');
      const missing = StartConversationInput(sourceLanguage: 'ko-KR', targetLanguage: '');
      expect(errorText(failureOf(h.session.start(same))!), 'Select two different languages.');
      expect(failureOf(h.session.start(missing)), isA<ArgumentError>().having((e) => e.message, 'message', 'Select two languages.'));

      const noServer = RealtimeEndpoints(apiBaseUrl: '', websocketBaseUrl: 'wss://example.test', appOrigin: 'https://app.example.test');
      expect(
        errorText(failureOf(h.sessionWith(noServer).start(input))!),
        "Set TELLUS_EXAMPLE_API_URL in flutter/.env, or run this example's development server (npm start).",
      );
      expect(h.snapshot.phase, SessionPhase.idle);
      expect(h.requests, isEmpty);
    });

    sessionTest('fails the start and ends the Conversation when the settings are refused', (h) {
      h.settingsStatus = 403;
      h.start();
      expect(h.state, (SessionPhase.error, 'Permission denied.'));
      expect(h.endRequests, hasLength(1));
      expect(h.sockets, isEmpty);

      // The next Start opens a new Conversation.
      h.settingsStatus = 200;
      h.start();
      expect(h.state, (SessionPhase.recording, null));
    });

    sessionTest('fails the start and ends the Conversation when no token is issued', (h) {
      h.tokenReplies.add(401);
      h.start();
      expect(h.state, (SessionPhase.error, 'Token refused with 401.'));
      expect(h.sockets, isEmpty);
      expect(h.endRequests, hasLength(1));
    });

    sessionTest('fails the start when Result does not open within 10 seconds', (h) {
      h.onConnect = (_) {};
      h.session.start(input);
      h.elapse(const Duration(milliseconds: 9999));
      expect(h.snapshot.phase, SessionPhase.connecting);
      expect(h.snapshot.resultConnection, ConnectionStatus.connecting);
      h.elapse(oneMs);

      expect(h.state, (SessionPhase.error, 'The realtime connection closed while starting. (result closed: 1006)'));
      expect(h.endRequests, hasLength(1));
      expect(h.socketKinds, ['result']);
    });

    sessionTest('fails the start with the server message when /audio is accepted and then refused', (h) {
      h.onConnect = (socket) {
        socket.open();
        if (socket.kind != SocketKind.audio) return;
        socket.receive(systemError(1008, 'interpretation_settings_not_found', 'Interpretation settings were not found.'));
        socket.serverClose(1008, 'interpretation_settings_not_found');
      };
      h.start();

      expect(h.state, (SessionPhase.error, 'Interpretation settings were not found. (interpretation_settings_not_found)'));
      expect(h.connections, (closed, closed));
      expect(h.endRequests, hasLength(1));
      expect(h.microphone.capturing, isFalse);
      h.elapse(const Duration(seconds: 60));
      expect(h.socketKinds, ['result', 'audio']);
    });

    sessionTest('fails the start without POST /end when the server reports the Conversation as gone', (h) {
      h.onConnect = (socket) {
        socket.open();
        socket.receive(systemError(1008, 'conversation_not_found', 'Conversation not found.'));
        socket.serverClose(1008, 'conversation_not_found');
      };
      h.start();

      expect(h.state, (
        SessionPhase.error,
        'The realtime connection closed while starting. (result closed: 1008 conversation_not_found)',
      ));
      expect(h.endRequests, isEmpty);
      expect(h.socketKinds, ['result']);
    });

    sessionTest('fails the start when the first engine approval gets no answer', (h) {
      h.microphone.authorizationError = const TellusAudioException('engine_authorization_timeout');
      h.start();

      expect(h.state, (SessionPhase.error, 'The realtime connection closed while starting. (audio closed: 1006)'));
      expect(h.microphone.capturing, isFalse);
      expect(h.endRequests, hasLength(1));
    });

    sessionTest('reports failed SDK initialization without a request or a socket', (h) {
      h.microphone.prepareError = StateError('Audio SDK is required but could not be initialized: missing engine');
      h.start();

      expect(h.state, (SessionPhase.error, 'Audio SDK is required but could not be initialized: missing engine'));
      expect(h.snapshot.audioSdkReady, isFalse);
      expect(h.requests, isEmpty);
      expect(h.sockets, isEmpty);
    });

    sessionTest('stops the microphone when it finishes starting after Stop', (h) {
      final starting = Completer<void>();
      h.microphone.startGate = starting.future;
      h.start();
      expect(h.snapshot.phase, SessionPhase.recording);
      expect(h.run(h.session.stop()), isTrue);
      expect(h.snapshot.phase, SessionPhase.ended);

      // Nothing else stops a capture that starts after the session has ended.
      starting.complete();
      h.flush();
      expect(h.microphone.started, isFalse);
      expect(h.snapshot.phase, SessionPhase.ended);
    });
  });

  group('results', () {
    sessionTest('update the rows, and a message that is not valid is shown without ending the session', (h) {
      h.start();
      h.resultSocket.receive(result('transcript.preview', 0, '안녕'));
      expect(h.rows, [(0, '안녕', null)]);
      h.resultSocket.receive(result('transcript.final', 0, '안녕하세요.'));
      h.resultSocket.receive(result('translation.final', 0, 'Hello.', 'en-US'));
      expect(h.rows, [(0, '안녕하세요.', 'Hello.')]);
      expect(h.snapshot.rows.single.source?.isFinal, isTrue);

      h.resultSocket.receive({
        'type': 'transcript.final',
        'data': {'conversation_id': 'conversation-1'},
      });
      expect(h.state, (SessionPhase.recording, 'Invalid Result WebSocket payload.'));
      expect(h.connections, (open, open));

      h.resultSocket.receive(result('transcript.final', 1, '반갑습니다.'));
      h.microphone.emit();
      expect(h.rows, [(0, '안녕하세요.', 'Hello.'), (1, '반갑습니다.', null)]);
      expect(h.audioSocket.sent.last, isA<List<int>>());
      expect(h.endRequests, isEmpty);
    });
  });

  group('pause and resume', () {
    sessionTest('pause stops the audio and tells the server; resume tells it again and sends audio', (h) {
      h.start();
      h.microphone.emit();
      expect(h.run(h.session.pause()), isTrue);
      expect(h.snapshot.phase, SessionPhase.paused);
      expect(h.microphone.capturing, isFalse);
      // A frame that the capture still delivers is not sent.
      h.microphone.emit();

      expect(h.run(h.session.resume()), isTrue);
      expect(h.snapshot.phase, SessionPhase.recording);
      expect(h.microphone.capturing, isTrue);
      h.microphone.emit();

      expect(h.audioSocket.sent.map(FakeSocket.describe), [
        'audio.status capturing',
        'audio frame',
        'audio.status paused',
        'audio.status capturing',
        'audio frame',
      ]);
      // `boundary_sample` is the number of samples sent before the status: one frame of 320.
      expect(h.audioSocket.statuses.map((status) => (status['status_seq'], status['boundary_sample'])), [(1, 0), (2, 320), (3, 320)]);
      expect(h.sockets, hasLength(2));
    });

    sessionTest('stays paused when /audio reconnects during a pause', (h) {
      h.start();
      h.run(h.session.pause());
      h.audioSocket.serverClose(1006);
      h.flush();
      expect(h.snapshot.phase, SessionPhase.reconnecting);

      final reopened = h.reopenedAfter(const Duration(seconds: 1));
      expect(h.snapshot.phase, SessionPhase.paused);
      expect(h.snapshot.audioConnection, open);
      expect(h.microphone.capturing, isFalse);
      expect(reopened.sent.map(FakeSocket.describe), ['audio.status paused']);
    });

    sessionTest('comes back paused when pause() arrives while /audio is reconnecting', (h) {
      h.start();
      h.audioSocket.serverClose(1006);
      h.flush();
      expect(h.snapshot.phase, SessionPhase.reconnecting);
      h.run(h.session.pause());
      expect(h.snapshot.phase, SessionPhase.reconnecting);

      final reopened = h.reopenedAfter(const Duration(seconds: 1));
      expect(h.state, (SessionPhase.paused, null));
      expect(h.microphone.capturing, isFalse);
      expect(reopened.sent.map(FakeSocket.describe), ['audio.status paused']);

      // The user resumes as after any other pause.
      h.run(h.session.resume());
      expect(h.snapshot.phase, SessionPhase.recording);
      expect(h.microphone.capturing, isTrue);
      expect(reopened.sent.map(FakeSocket.describe).last, 'audio.status capturing');
    });
  });

  group('stop', () {
    sessionTest('sends idle, waits for the last finals, closes /audio, ends, then closes Result', (h) {
      h.sendsEnded = false;
      h.start();
      h.microphone.emit();
      h.resultSocket.receive(result('transcript.preview', 0, '안녕'));
      h.timeline.clear();

      final stopped = h.completion(h.session.stop());
      h.flush();
      expect(h.timeline, ['audio.status idle']);
      expect(h.snapshot.phase, SessionPhase.stopping);

      h.elapse(const Duration(seconds: 1));
      h.resultSocket.receive(result('transcript.final', 0, '안녕하세요.'));
      h.flush();
      // The transcript is final, but its translation is still missing.
      expect(h.timeline, hasLength(1));
      h.resultSocket.receive(result('translation.final', 0, 'Hello.', 'en-US'));
      h.flush();
      expect(h.timeline.sublist(1), ['audio close', 'POST $endPath']);
      expect(h.audioSocket.detached, isTrue);
      expect(h.resultSocket.isOpen, isTrue);
      expect(h.snapshot.phase, SessionPhase.stopping);
      expect(stopped(), isFalse);

      // Results that arrive before conversation.ended are still shown.
      h.resultSocket.receive(result('transcript.final', 1, '마지막 문장.'));
      h.resultSocket.receive({'type': 'conversation.ended', 'data': {}});
      h.flush();
      expect(stopped(), isTrue);
      expect(h.timeline.sublist(3), ['result close']);
      expect(h.state, (SessionPhase.ended, null));
      expect(h.connections, (closed, closed));
      expect(h.rows.map((row) => row.$2), ['안녕하세요.', '마지막 문장.']);
      expect(h.endRequests, hasLength(1));
      expect(h.snapshot.audioSdkReady, isFalse);
    });

    sessionTest('sends the last packet that the capture delivers while it stops, before the idle status', (h) {
      h.start();
      h.microphone.lastPackets = 1;
      expect(h.run(h.session.stop()), isTrue);

      expect(h.audioSocket.sent.map(FakeSocket.describe), ['audio.status capturing', 'audio frame', 'audio.status idle']);
      expect(h.audioSocket.statuses.last, containsPair('boundary_sample', 320));
      expect(recordedPacketCount(h.session.getRecording().data), 1);
    });

    sessionTest('waits at most 2 seconds for the last final', (h) {
      h.start();
      h.resultSocket.receive(result('transcript.preview', 0, '안녕'));
      final stopped = h.completion(h.session.stop());
      h.elapse(const Duration(milliseconds: 1999));
      expect(h.endRequests, isEmpty);
      h.elapse(oneMs);

      expect(stopped(), isTrue);
      expect(h.endRequests, hasLength(1));
      expect(h.snapshot.phase, SessionPhase.ended);
    });

    sessionTest('does not wait for finals when the Result socket is not open', (h) {
      h.start();
      h.resultSocket.receive(result('transcript.preview', 0, '안녕'));
      h.resultSocket.serverClose(1006);

      expect(h.run(h.session.stop()), isTrue);
      expect(h.endRequests, hasLength(1));
      expect(h.snapshot.phase, SessionPhase.ended);
    });

    sessionTest('closes Result 5 seconds after POST /end answers when conversation.ended never arrives', (h) {
      h.sendsEnded = false;
      h.start();
      final stopped = h.completion(h.session.stop());
      h.elapse(const Duration(milliseconds: 4999));
      expect(h.resultSocket.isOpen, isTrue);
      expect(h.snapshot.phase, SessionPhase.stopping);
      h.elapse(oneMs);

      expect(stopped(), isTrue);
      expect(h.resultSocket.closed, isTrue);
      expect(h.snapshot.phase, SessionPhase.ended);
    });

    sessionTest('calls POST /end again after 503 and treats 410 as ended', (h) {
      h.endStatuses.addAll([503, 503, 410]);
      h.start();
      final stopped = h.completion(h.session.stop());
      h.flush();
      expect(h.endRequests, hasLength(1));
      h.elapse(const Duration(seconds: 1));
      expect(h.endRequests, hasLength(2));
      h.elapse(const Duration(seconds: 2));
      expect(h.endRequests, hasLength(3));
      h.elapse(const Duration(seconds: 5));

      expect(stopped(), isTrue);
      expect(h.endRequests, hasLength(3));
      expect(h.state, (SessionPhase.ended, null));
    });

    sessionTest('ends in error when POST /end keeps answering 503', (h) {
      h.endStatuses.addAll([503, 503, 503, 503]);
      h.start();
      final stopped = h.completion(h.session.stop());
      h.elapse(const Duration(seconds: 8));

      expect(stopped(), isTrue);
      expect(h.endRequests, hasLength(4));
      expect(h.state, (SessionPhase.error, 'Temporarily unavailable.'));
      expect(h.snapshot.resultConnection, closed);
      expect(h.resultSocket.closed, isTrue);
    });

    sessionTest('ends in error when POST /end is never answered', (h) {
      h.endStatuses.addAll([Reply.noAnswer, Reply.noAnswer, Reply.noAnswer, Reply.noAnswer]);
      h.start();
      final stopped = h.completion(h.session.stop());
      // Four requests of 15 seconds each, with waits of 1, 2, and 5 seconds between them.
      h.elapse(const Duration(milliseconds: 67999));
      expect(h.snapshot.phase, SessionPhase.stopping);
      h.elapse(oneMs);

      expect(stopped(), isTrue);
      expect(h.endRequests, hasLength(4));
      expect(h.state, (SessionPhase.error, 'The request timed out.'));
      expect(h.resultSocket.closed, isTrue);
    });

    sessionTest('ends the Conversation when stop() arrives while the sockets are opening', (h) {
      h.onConnect = (_) {};
      h.start();
      expect(h.snapshot.phase, SessionPhase.connecting);
      expect(h.snapshot.resultConnection, ConnectionStatus.connecting);

      expect(h.run(h.session.stop()), isTrue);
      expect(h.state, (SessionPhase.ended, null));
      expect(h.snapshot.resultConnection, closed);
      expect(h.endRequests, hasLength(1));
      expect(h.sockets.last.detached, isTrue);
      h.elapse(const Duration(seconds: 60));
      expect(h.socketKinds, ['result']);
    });

    sessionTest('cancels a pending reconnect', (h) {
      h.sendsEnded = false;
      h.start();
      h.audioSocket.serverClose(1006);
      final stopped = h.completion(h.session.stop());
      h.flush();
      expect(h.snapshot.phase, SessionPhase.stopping);
      h.elapse(const Duration(seconds: 5));

      expect(stopped(), isTrue);
      expect(h.state, (SessionPhase.ended, null));
      h.elapse(const Duration(seconds: 60));
      expect(h.socketKinds, ['result', 'audio']);
    });
  });

  group('reconnect', () {
    sessionTest('keeps sending audio while only Result reconnects, and asks for the finals it has not handled', (h) {
      h.start();
      expect(h.resultSocket.url, 'wss://example.test/v1/conversations/conversation-1/results');
      h.resultSocket.receive(result('transcript.final', 0, '안녕하세요.'));
      h.resultSocket.receive(result('translation.final', 0, 'Hello.', 'en-US'));
      // The translation of this one was not received before the close.
      h.resultSocket.receive(result('transcript.final', 1, '반갑습니다.'));
      h.resultSocket.serverClose(1013, 'result_send_failed');
      h.flush();
      expect(h.state, (SessionPhase.recording, null));
      expect(h.connections, (closed, open));
      expect(h.microphone.capturing, isTrue);

      h.microphone.emit();
      expect(h.audioSocket.sent.last, isA<List<int>>());

      final requestsBeforeReconnect = [...h.requests];
      final reopened = h.reopenedAfter(const Duration(seconds: 1));
      expect(h.socketKinds, ['result', 'audio', 'result']);
      expect(h.audioSocket.isOpen, isTrue);
      expect(h.audioSocket.detached, isFalse);
      expect(h.state, (SessionPhase.recording, null));
      expect(h.connections, (open, open));

      // Row 0 is complete, so the server sends the stored finals after it again, then live results.
      expect(reopened.url, 'wss://example.test/v1/conversations/conversation-1/results?after_order_seq=0');
      reopened.receive(result('transcript.final', 1, '반갑습니다.'));
      reopened.receive(result('translation.final', 1, 'Nice to meet you.', 'en-US'));
      reopened.receive(result('transcript.final', 2, '다시 연결됐습니다.'));
      h.elapse(const Duration(seconds: 10));
      expect(h.rows, [(0, '안녕하세요.', 'Hello.'), (1, '반갑습니다.', 'Nice to meet you.'), (2, '다시 연결됐습니다.', null)]);
      // The token was still valid, so the reconnect made no request.
      expect(h.requests, requestsBeforeReconnect);

      h.microphone.emit();
      // One status when recording started, then nothing but audio: the sample cursor went on.
      expect(h.audioSocket.sent.map(FakeSocket.describe), ['audio.status capturing', 'audio frame', 'audio frame']);
      expect(h.microphone.authorizations, hasLength(1));
    });

    sessionTest('reopens only /audio, after retry_after_ms, with a new engine approval and a fresh sample cursor', (h) {
      h.start();
      h.microphone.emit();
      h.microphone.emit();

      h.audioSocket.receive(
        systemError(1013, rateLimited, 'Audio pipeline reconnect rate limit exceeded.', {'retry_after_ms': 3000}),
      );
      h.audioSocket.serverClose(1013, rateLimited);
      h.flush();
      expect(h.state, (SessionPhase.reconnecting, null));
      expect(h.connections, (open, closed));
      expect(h.microphone.capturing, isFalse);

      final reopened = h.reopenedAfter(const Duration(seconds: 3));
      expect(h.socketKinds, ['result', 'audio', 'audio']);
      expect(h.resultSocket.isOpen, isTrue);
      expect(h.resultSocket.detached, isFalse);
      expect(h.state, (SessionPhase.recording, null));
      expect(h.connections, (open, open));
      expect(h.microphone.capturing, isTrue);
      // The same capture is approved again on the new socket, once that is open.
      expect(h.microphone.authorizations, [(h.audioSocket, true), (reopened, true)]);
      expect(reopened.headers['Authorization'], 'Bearer token-1');

      h.microphone.emit();
      // Status first, then audio counted from sample 0 again.
      expect(reopened.sent.map(FakeSocket.describe), ['audio.status capturing', 'audio frame']);
      // status_seq keeps counting through the Conversation.
      expect(reopened.statuses.single, containsPair('status_seq', 2));
      expect(reopened.statuses.single, containsPair('boundary_sample', 0));

      // The rate limit belonged to the old socket: the next close uses the plain backoff.
      reopened.serverClose(1006);
      h.reopenedAfter(const Duration(seconds: 2));
    });

    sessionTest('opens Result first when both sockets closed, and /audio only after Result is open', (h) {
      h.start();
      h.onConnect = (_) {};
      h.resultSocket.serverClose(1006);
      h.audioSocket.serverClose(1006);
      h.flush();
      expect(h.snapshot.phase, SessionPhase.reconnecting);
      expect(h.connections, (closed, closed));

      final reopenedResult = h.reopenedAfter(const Duration(seconds: 1));
      h.elapse(const Duration(seconds: 5));
      expect(h.socketKinds, ['result', 'audio', 'result']);

      reopenedResult.open();
      h.flush();
      expect(h.socketKinds, ['result', 'audio', 'result', 'audio']);
      expect(h.snapshot.phase, SessionPhase.reconnecting);
      expect(h.snapshot.resultConnection, open);

      h.sockets.last.open();
      h.flush();
      expect(h.snapshot.phase, SessionPhase.recording);
      expect(h.snapshot.audioConnection, open);
    });

    sessionTest('adds a socket that closes during the wait to the pending reconnect, keeping its timer', (h) {
      h.start();
      h.resultSocket.serverClose(1006);
      h.elapse(const Duration(milliseconds: 600));
      h.audioSocket.serverClose(1006);
      h.reopenedAfter(const Duration(milliseconds: 400));
      expect(h.socketKinds, ['result', 'audio', 'result', 'audio']);

      // The two closes counted as one attempt, so the next wait is the second backoff step.
      h.sockets.last.serverClose(1006);
      h.reopenedAfter(const Duration(seconds: 2));
    });

    sessionTest('keeps reconnecting when the server accepts the new /audio socket and refuses it right away', (h) {
      h.start();
      h.onConnect = (socket) {
        socket.open();
        socket.receive(systemError(1013, rateLimited, 'Audio pipeline reconnect rate limit exceeded.', {'retry_after_ms': 800}));
        socket.serverClose(1013, rateLimited);
      };
      h.audioSocket.serverClose(1006);
      h.reopenedAfter(const Duration(seconds: 1));
      expect(h.state, (SessionPhase.reconnecting, null));
      expect(h.snapshot.audioConnection, closed);
      expect(h.microphone.capturing, isFalse);

      h.onConnect = (socket) => socket.open();
      h.reopenedAfter(const Duration(seconds: 2));
      expect(h.snapshot.phase, SessionPhase.recording);
      expect(h.microphone.capturing, isTrue);
    });

    sessionTest('backs off further when a reopened socket closes again, and starts over after 30 stable seconds', (h) {
      h.start();
      h.audioSocket.serverClose(1011);
      var reopened = h.reopenedAfter(const Duration(seconds: 1));

      reopened.serverClose(1011);
      reopened = h.reopenedAfter(const Duration(seconds: 2));

      h.elapse(const Duration(milliseconds: 29999));
      reopened.serverClose(1011);
      reopened = h.reopenedAfter(const Duration(seconds: 5));

      h.elapse(const Duration(seconds: 30));
      reopened.serverClose(1011);
      h.reopenedAfter(const Duration(seconds: 1));
    });

    sessionTest('gives up an attempt that does not open within 10 seconds and ignores that socket afterwards', (h) {
      h.start();
      h.onConnect = (_) {};
      h.audioSocket.serverClose(1006);
      final stalled = h.reopenedAfter(const Duration(seconds: 1));

      h.elapse(const Duration(seconds: 10));
      expect(stalled.closed, isTrue);
      expect(stalled.detached, isTrue);
      expect(h.snapshot.phase, SessionPhase.reconnecting);
      expect(h.snapshot.audioConnection, closed);

      h.onConnect = (socket) => socket.open();
      h.reopenedAfter(const Duration(seconds: 2));
      stalled.serverClose(1008, 'audio_pipeline_fenced');
      h.flush();
      expect(h.state, (SessionPhase.recording, null));
      expect(h.snapshot.audioConnection, open);
      expect(h.socketKinds, ['result', 'audio', 'audio', 'audio']);
    });

    sessionTest('reopens /audio only after the microphone has paused', (h) {
      h.start();
      final pausing = Completer<void>();
      h.microphone.pauseGate = pausing.future;
      h.audioSocket.serverClose(1006);
      h.elapse(const Duration(seconds: 1));
      expect(h.socketKinds, ['result', 'audio']);

      pausing.complete();
      h.flush();
      expect(h.socketKinds, ['result', 'audio', 'audio']);
    });

    sessionTest('ends the session when the microphone cannot be resumed after reconnecting', (h) {
      h.start();
      h.microphone.resumeError = StateError('Unable to resume the microphone stream.');
      h.audioSocket.serverClose(1006);
      h.reopenedAfter(const Duration(seconds: 1));

      expect(h.state, (SessionPhase.error, 'Unable to resume the microphone stream.'));
      expect(h.endRequests, hasLength(1));
      h.elapse(const Duration(seconds: 60));
      expect(h.socketKinds, ['result', 'audio', 'audio']);
    });
  });

  group('when iOS changes the audio hardware', () {
    sessionTest('starts the microphone again once, and ends the session at a second change within a minute', (h) {
      h.start();
      h.microphone.fail(const TellusAudioException('audio_configuration_changed'));
      h.microphone.capturing = false;
      h.flush();
      expect(h.state, (SessionPhase.recording, null));
      expect(h.microphone.capturing, isTrue);
      expect(h.connections, (open, open));

      h.elapse(const Duration(seconds: 30));
      h.microphone.fail(const TellusAudioException('audio_configuration_changed'));
      h.flush();
      expect(h.snapshot.phase, SessionPhase.error);
      expect(h.snapshot.error, 'audio_configuration_changed');
    });

    sessionTest('starts it again after a minute has passed', (h) {
      h.start();
      h.microphone.fail(const TellusAudioException('audio_configuration_changed'));
      h.flush();
      h.elapse(const Duration(minutes: 1));
      h.microphone.capturing = false;
      h.microphone.fail(const TellusAudioException('audio_configuration_changed'));
      h.flush();
      expect(h.state, (SessionPhase.recording, null));
      expect(h.microphone.capturing, isTrue);
    });

    sessionTest('ends the session when the restart fails', (h) {
      h.start();
      h.microphone.resumeError = const TellusAudioException('microphone_already_running');
      h.microphone.fail(const TellusAudioException('audio_configuration_changed'));
      h.flush();
      expect(h.snapshot.phase, SessionPhase.error);
      expect(h.snapshot.error, 'microphone_already_running');
    });

    sessionTest('still ends the session at any other capture error', (h) {
      h.start();
      h.microphone.fail(const TellusAudioException('audio_interrupted'));
      h.flush();
      expect(h.snapshot.phase, SessionPhase.error);
      expect(h.snapshot.error, 'audio_interrupted');
    });
  });

  group('engine approval that is lost while recording', () {
    for (final code in ['engine_authorization_timeout', 'engine_authorization_expired']) {
      sessionTest('reconnects /audio after $code', (h) {
        h.start();
        h.microphone.loseAuthorization(TellusAudioException(code));
        h.flush();
        expect(h.state, (SessionPhase.reconnecting, null));
        expect(h.audioSocket.closed, isTrue);

        final reopened = h.reopenedAfter(const Duration(seconds: 1));
        expect(h.snapshot.phase, SessionPhase.recording);
        expect(h.microphone.authorizations, [(h.audioSocket, true), (reopened, true)]);
      });
    }

    // The Audio SDK saw the socket close or a `system.error`. The close itself decides what
    // happens; the session waits for it, without sending audio.
    sessionTest('waits 10 seconds for the close of the socket, then reconnects', (h) {
      h.start();
      h.microphone.loseAuthorization(const TellusAudioException('engine_authorization_server_error'));
      h.microphone.emit();
      expect(h.audioSocket.sent.map(FakeSocket.describe), ['audio.status capturing']);
      h.elapse(const Duration(milliseconds: 9999));
      expect(h.snapshot.phase, SessionPhase.recording);
      h.elapse(oneMs);
      expect(h.state, (SessionPhase.reconnecting, null));

      h.reopenedAfter(const Duration(seconds: 1));
      expect(h.snapshot.phase, SessionPhase.recording);
    });

    sessionTest('ends the session with the code of the engine for any other error', (h) {
      h.start();
      h.microphone.loseAuthorization(const TellusAudioException('engine_access_denied'));
      h.flush();

      expect(h.state, (SessionPhase.error, 'engine_access_denied'));
      expect(h.endRequests, hasLength(1));
      h.elapse(const Duration(seconds: 60));
      expect(h.socketKinds, ['result', 'audio']);
    });
  });

  group('when the Conversation ends on the server', () {
    for (final kind in SocketKind.values) {
      sessionTest('shows it as ended, without POST /end, when ${kind.name} closes with 1000', (h) {
        h.start();
        h.sockets[kind.index].serverClose(1000, 'conversation_ended');
        h.flush();

        expect(h.state, (SessionPhase.ended, null));
        expect(h.connections, (closed, closed));
        expect(h.endRequests, isEmpty);
        expect(h.microphone.capturing, isFalse);
        expect((h.resultSocket.closed, h.audioSocket.closed), (true, true));

        h.elapse(const Duration(seconds: 60));
        expect(h.socketKinds, ['result', 'audio']);
      });
    }

    sessionTest('takes the same path for conversation.ended', (h) {
      h.start();
      h.resultSocket.receive({
        'type': 'conversation.ended',
        'data': {'conversation_id': 'conversation-1'},
      });
      // Both sockets are detached at once, so the 1000 that follows is not handled a second time.
      expect((h.resultSocket.detached, h.audioSocket.detached), (true, true));
      h.flush();

      expect(h.state, (SessionPhase.ended, null));
      expect(h.endRequests, isEmpty);
    });

    sessionTest('treats system.error conversation_ended followed by 1008 as ended', (h) {
      h.start();
      h.resultSocket.receive(systemError(1008, 'conversation_ended', 'Conversation has already ended.'));
      expect(h.state, (SessionPhase.recording, null));
      h.resultSocket.serverClose(1008);
      h.flush();

      expect(h.state, (SessionPhase.ended, null));
      expect(h.endRequests, isEmpty);
    });
  });

  group('when the server refuses a socket', () {
    sessionTest('stops with the server message and calls POST /end after 1008 interpretation_settings_changed', (h) {
      h.start();
      h.audioSocket.receive(systemError(1008, 'interpretation_settings_changed', 'Interpretation worker revision conflict.'));
      // The message alone changes nothing; the close decides.
      expect(h.state, (SessionPhase.recording, null));
      h.audioSocket.serverClose(1008, 'interpretation_settings_changed');
      h.flush();

      expect(h.state, (SessionPhase.error, 'Interpretation worker revision conflict. (interpretation_settings_changed)'));
      expect(h.connections, (closed, closed));
      expect(h.endRequests, hasLength(1));
      expect(h.microphone.capturing, isFalse);

      h.elapse(const Duration(seconds: 60));
      expect(h.socketKinds, ['result', 'audio']);
    });

    sessionTest('stops but leaves the Conversation open after 1008 audio_connection_replaced', (h) {
      h.start();
      h.audioSocket.receive(systemError(1008, 'audio_connection_replaced', 'Audio connection was replaced.'));
      h.audioSocket.serverClose(1008);
      // Neither a stop() during the cleanup nor one after it may end the Conversation: leaving
      // the screen calls stop().
      expect(h.run(h.session.stop()), isTrue);

      expect(h.state, (SessionPhase.error, 'Another device or tab took over the audio of this Conversation.'));
      expect(h.run(h.session.stop()), isTrue);
      expect(h.snapshot.phase, SessionPhase.error);
      expect(h.endRequests, isEmpty);
    });

    for (final kind in SocketKind.values) {
      sessionTest('stops without reconnecting when ${kind.name} closes with 4401', (h) {
        h.start();
        h.sockets[kind.index].serverClose(4401, 'API key expired');
        h.flush();

        expect(h.state, (SessionPhase.error, 'The server no longer accepts the API key. (API key expired)'));
        h.elapse(const Duration(seconds: 60));
        expect(h.socketKinds, ['result', 'audio']);
      });
    }

    sessionTest('shows the error before POST /end answers, and stop() waits for that POST /end', (h) {
      h.start();
      final held = Completer<void>();
      h.endGate = held.future;
      h.audioSocket.serverClose(1008, 'interpretation_settings_changed');
      h.flush();
      expect(h.state, (SessionPhase.error, 'The server refused the connection. (interpretation_settings_changed)'));
      expect(h.connections, (closed, closed));
      expect(h.endRequests, hasLength(1));

      final stopped = h.completion(h.session.stop());
      h.flush();
      expect(stopped(), isFalse);
      held.complete();
      h.flush();
      expect(stopped(), isTrue);
      // stop() did nothing of its own: the phase stays, and no second POST /end was sent.
      expect(h.snapshot.phase, SessionPhase.error);
      expect(h.endRequests, hasLength(1));
    });

    sessionTest('ends the session when the microphone reports an error', (h) {
      h.start();
      h.microphone.fail(const TellusAudioException('capture_failed', engineMessage: 'The recorder stopped.'));
      h.flush();

      expect(h.state, (SessionPhase.error, 'capture_failed (The recorder stopped.)'));
      expect(h.connections, (closed, closed));
      expect(h.endRequests, hasLength(1));
    });
  });

  group('access tokens', () {
    sessionTest('reuses the token for a reconnect and for an engine renewal while it is valid', (h) {
      h.start();
      h.elapse(const Duration(minutes: 9));
      expect(h.valueOf(h.microphone.getAccessToken!()), 'token-1');
      h.audioSocket.serverClose(1006);
      expect(h.reopenedAfter(const Duration(seconds: 1)).headers['Authorization'], 'Bearer token-1');
      expect(h.tokenRequests, hasLength(1));
    });

    sessionTest('issues a new token for a reconnect and for an engine renewal once the first is about to expire', (h) {
      h.start();
      h.elapse(tokenLifetime - const Duration(seconds: 60));
      expect(h.valueOf(h.microphone.getAccessToken!()), 'token-2');
      h.elapse(tokenLifetime);
      h.audioSocket.serverClose(1006);
      expect(h.reopenedAfter(const Duration(seconds: 1)).headers['Authorization'], 'Bearer token-3');
      expect(h.snapshot.phase, SessionPhase.recording);
      expect(h.snapshot.audioConnection, open);
    });

    group('when the token for a reconnect cannot be issued', () {
      void reconnectWithExpiredToken(Harness h, List<Object> replies) {
        h.start();
        h.elapse(tokenLifetime);
        h.tokenReplies.addAll(replies);
        h.audioSocket.serverClose(1006);
        h.elapse(const Duration(seconds: 1));
      }

      for (final status in [404, 410]) {
        sessionTest('shows the Conversation as ended, without POST /end, after $status', (h) {
          reconnectWithExpiredToken(h, [status]);
          expect(h.state, (SessionPhase.ended, null));
          expect(h.endRequests, isEmpty);
          expect(h.socketKinds, ['result', 'audio']);
        });
      }

      sessionTest('stops with the server message after 401', (h) {
        reconnectWithExpiredToken(h, [401]);
        expect(h.state, (SessionPhase.error, 'Token refused with 401.'));
        expect(h.endRequests, hasLength(1));
      });

      // Asking again would get the same answer, so the session stops instead of retrying forever.
      sessionTest('stops when the answer has no token', (h) {
        reconnectWithExpiredToken(h, [Reply.malformedToken]);
        expect(h.state, (SessionPhase.error, 'Access token response is missing access_token or expires_at_ms.'));
        expect(h.socketKinds, ['result', 'audio']);
      });

      // 504: this app's server asked Tellus and got no answer in time.
      for (final MapEntry(key: name, value: failure) in {
        'the request gets no response': Reply.networkFailure,
        "this app's server answers 504": 504,
      }.entries) {
        sessionTest('keeps reconnecting with backoff when $name', (h) {
          // The request itself is repeated after 1, 2, and 5 seconds before the attempt gives up.
          reconnectWithExpiredToken(h, List.filled(4, failure));
          h.elapse(const Duration(seconds: 8));
          expect(h.state, (SessionPhase.reconnecting, null));
          expect(h.socketKinds, ['result', 'audio']);

          h.reopenedAfter(const Duration(seconds: 2));
          expect(h.snapshot.phase, SessionPhase.recording);
          expect(h.snapshot.audioConnection, open);
        });
      }
    });
  });

  group('denoise', () {
    (bool enabled, bool? applied, bool updating, String? error) denoise(Harness h) {
      final denoise = h.snapshot.denoise;
      return (denoise.enabled, denoise.applied, denoise.updating, denoise.error);
    }

    sessionTest('uses a pre-start selection and changes denoise during recording without replacing sockets', (h) {
      expect(denoise(h), (true, null, false, null));
      h.run(h.session.setDenoiseEnabled(false));
      expect(denoise(h), (false, null, false, null));
      h.start();
      expect(denoise(h), (false, false, false, null));

      h.session.setDenoiseEnabled(true);
      expect(h.snapshot.denoise.updating, isTrue);
      h.flush();
      expect(denoise(h), (true, true, false, null));
      expect(h.snapshot.phase, SessionPhase.recording);
      expect(h.microphone.capturing, isTrue);
      expect(h.socketKinds, ['result', 'audio']);
      expect(h.endRequests, isEmpty);
    });

    sessionTest('shows a rejected denoise change while keeping the last setting and translation running', (h) {
      h.start();
      h.microphone.denoiseError = const TellusAudioException('model_not_ready');
      h.run(h.session.setDenoiseEnabled(false));

      expect(denoise(h), (true, true, false, 'Unable to change Audio SDK denoise: model_not_ready'));
      expect(h.state, (SessionPhase.recording, null));
      expect(h.microphone.capturing, isTrue);
      expect(h.endRequests, isEmpty);
    });

    sessionTest('unlocks the switch and Start when the session ends during a denoise change', (h) {
      h.start();
      h.session.setDenoiseEnabled(false);
      expect(h.snapshot.denoise.updating, isTrue);
      h.audioSocket.serverClose(1000, 'conversation_ended');
      h.flush();

      expect(h.state, (SessionPhase.ended, null));
      expect(h.snapshot.denoise.updating, isFalse);
      h.start();
      expect(h.snapshot.phase, SessionPhase.recording);
    });

    // The change waits behind Stop, and reaches the microphone only after the session has ended.
    sessionTest('shows the setting the microphone keeps when the session ends before a change applies', (h) {
      h.start();
      h.session.stop();
      h.session.setDenoiseEnabled(false);
      h.flush();

      expect(h.snapshot.phase, SessionPhase.ended);
      expect(h.microphone.denoiseEnabled, isFalse);
      expect(denoise(h), (false, null, false, null));
      h.start();
      expect(denoise(h), (false, false, false, null));
    });

    sessionTest('changes denoise while paused and preserves it for the next session', (h) {
      h.start();
      h.run(h.session.pause());
      h.run(h.session.setDenoiseEnabled(false));
      expect(h.snapshot.phase, SessionPhase.paused);
      expect(denoise(h), (false, false, false, null));
      expect(h.microphone.capturing, isFalse);

      h.run(h.session.stop());
      expect(denoise(h), (false, null, false, null));
      h.start();
      expect(denoise(h), (false, false, false, null));
    });
  });

  group('recording', () {
    sessionTest('offers captured audio after Stop, retains Pause/Resume audio, and resets on the next Start', (h) {
      h.start();
      expect(h.snapshot.recordingAvailable, isFalse);
      expect(
        h.session.getRecording,
        throwsA(isA<StateError>().having((e) => e.message, 'message', 'Stop the session before downloading audio.')),
      );
      h.microphone.emit();
      h.run(h.session.pause());
      h.run(h.session.resume());
      h.microphone.emit();
      h.run(h.session.stop());
      expect(h.snapshot.recordingAvailable, isTrue);
      final file = h.session.getRecording();
      expect(file.fileName, endsWith('.ogg'));
      expect(recordedPacketCount(file.data), 2);
      expect(h.session.getRecording().data, file.data);

      h.start();
      expect(h.snapshot.recordingAvailable, isFalse);
      h.run(h.session.stop());
      expect(h.snapshot.recordingAvailable, isFalse);
      expect(
        h.session.getRecording,
        throwsA(isA<StateError>().having((e) => e.message, 'message', 'No captured audio is available to download.')),
      );
    });

    sessionTest('retains already captured audio when a socket failure ends the session', (h) {
      h.start();
      h.microphone.emit();
      h.resultSocket.serverClose(1008, 'forbidden');
      h.flush();
      expect(h.snapshot.phase, SessionPhase.error);
      expect(h.snapshot.recordingAvailable, isTrue);
      expect(recordedPacketCount(h.session.getRecording().data), 1);
    });

    sessionTest('includes the audio captured before and after an audio socket reconnect', (h) {
      h.start();
      h.microphone.emit();
      h.audioSocket.serverClose(1006);
      h.reopenedAfter(const Duration(seconds: 1));
      h.microphone.emit();
      h.run(h.session.stop());
      expect(recordedPacketCount(h.session.getRecording().data), 2);
    });
  });
}
