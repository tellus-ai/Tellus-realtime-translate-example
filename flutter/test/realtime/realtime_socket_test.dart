import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:tellus_flutter_example/src/realtime/realtime_socket.dart';

// These tests use a real WebSocket server on this machine, because `IoRealtimeSocket` is the one
// class of the session that talks to `dart:io`.
void main() {
  late HttpServer server;
  late String url;

  setUp(() async {
    server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
    url = 'ws://127.0.0.1:${server.port}/v1/audio?conversation_id=c1&audio_format=opus';
  });

  tearDown(() => server.close(force: true));

  test('sends the handshake headers and gives each text frame to the session and to the Audio SDK', () async {
    final handshake = Completer<HttpHeaders>();
    final accepted = Completer<WebSocket>();
    server.listen((request) async {
      handshake.complete(request.headers);
      accepted.complete(await WebSocketTransformer.upgrade(request));
    });

    final socket = IoRealtimeSocket(url, {'Origin': 'https://app.example.test', 'Authorization': 'Bearer token-1'});
    final opened = Completer<void>();
    final closed = Completer<(int, String)>();
    final sessionMessages = <String>[];
    final sdkMessages = <String>[];
    socket
      ..onOpen = opened.complete
      ..onMessage = sessionMessages.add
      ..onClose = (code, reason) => closed.complete((code, reason));
    // A second listener, as `attachEngineAuthorization` adds one.
    socket.messages.listen(sdkMessages.add);
    expect(socket.isOpen, isFalse);

    await opened.future;
    expect(socket.isOpen, isTrue);
    final headers = await handshake.future;
    expect(headers.value('origin'), 'https://app.example.test');
    expect(headers.value('authorization'), 'Bearer token-1');

    final peer = await accepted.future;
    final received = <Object?>[];
    final serverDone = Completer<void>();
    peer.listen(received.add, onDone: serverDone.complete);
    socket.send('{"type":"audio.status"}');
    socket.sendBytes([0xf8, 0xff, 0xfe]);
    peer.add('{"type":"engine.authorized"}');
    peer.add([1, 2, 3]);
    peer.add('{"type":"system.error"}');
    await peer.close(1008, 'auth_failed');

    // The code and the reason of the server's close frame reach the close policy.
    expect(await closed.future, (1008, 'auth_failed'));
    await socket.done;
    await serverDone.future;
    expect(socket.isOpen, isFalse);
    expect(sessionMessages, ['{"type":"engine.authorized"}', '{"type":"system.error"}']);
    expect(sdkMessages, sessionMessages);
    expect(received, [
      '{"type":"audio.status"}',
      [0xf8, 0xff, 0xfe],
    ]);
    // Nothing is sent, and nothing fails, on a socket that has closed.
    socket.send('late');
  });

  test('reports a refused handshake as an error followed by a 1006 close', () async {
    server.listen((request) {
      request.response.statusCode = HttpStatus.forbidden;
      request.response.close();
    });

    final socket = IoRealtimeSocket(url, const {});
    var errors = 0;
    final closed = Completer<(int, String)>();
    socket
      ..onOpen = (() => fail('The socket must not open.'))
      ..onError = (() => errors++)
      ..onClose = (code, reason) => closed.complete((code, reason));

    expect(await closed.future, (1006, ''));
    expect(errors, 1);
    expect(socket.isOpen, isFalse);
    await socket.done;
  });

  test('close() gives up a connection that is still opening, without an event', () async {
    final upgraded = Completer<WebSocket>();
    server.listen((request) async => upgraded.complete(await WebSocketTransformer.upgrade(request)));

    final socket = IoRealtimeSocket(url, const {});
    socket
      ..onOpen = (() => fail('The socket must not open.'))
      ..onClose = ((_, _) => fail('The client closed this socket itself.'));
    socket.close();
    await socket.done;

    // The connection that still got through is closed again.
    final peer = await upgraded.future;
    await peer.drain<void>();
    expect(peer.closeCode, 1000);
    expect(socket.isOpen, isFalse);
  });
}
