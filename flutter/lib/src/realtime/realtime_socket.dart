import 'dart:async';
import 'dart:io';

import 'package:tellus_audio_sdk/tellus_audio_sdk.dart';

enum SocketKind { result, audio }

/// One WebSocket to Tellus, from the moment it starts to connect.
///
/// The session sets the callbacks right after it creates the socket. The Audio SDK reads the
/// `/v1/audio` socket as well, for the engine approval: it uses the [EngineAuthorizationSocket]
/// part of this class.
abstract class RealtimeSocket implements EngineAuthorizationSocket {
  void Function()? onOpen;
  void Function(String text)? onMessage;
  void Function()? onError;

  /// A close that this client did not start. A connection that could not be opened ends here too.
  void Function(int code, String reason)? onClose;

  void sendBytes(List<int> data);

  /// Closes the socket, or gives up opening it.
  void close();
}

/// Starts to open a WebSocket with these handshake headers. Tests replace it with a fake.
typedef RealtimeSocketConnector = RealtimeSocket Function(String url, Map<String, String> headers);

/// A `dart:io` WebSocket. `dart:io` can send handshake headers, which a browser cannot.
class IoRealtimeSocket extends RealtimeSocket {
  IoRealtimeSocket(String url, Map<String, String> headers) {
    _connect(url, headers);
  }

  WebSocket? _socket;
  bool _closed = false;
  // A Dart WebSocket can be listened to only once, and both the session and the Audio SDK read
  // `/v1/audio`. This class listens, and passes each text frame on to `onMessage` and `messages`.
  final _messages = StreamController<String>.broadcast();
  final _done = Completer<void>();

  @override
  bool get isOpen => !_closed && _socket?.readyState == WebSocket.open;

  @override
  Stream<String> get messages => _messages.stream;

  @override
  Future<void> get done => _done.future;

  Future<void> _connect(String url, Map<String, String> headers) async {
    final WebSocket socket;
    try {
      socket = await WebSocket.connect(url, headers: headers);
    } catch (_) {
      // Unreachable, or the server answered the handshake with an HTTP error. Reported like a
      // connection lost without a close frame.
      if (_closed) return;
      onError?.call();
      _finish(WebSocketStatus.abnormalClosure, '');
      return;
    }
    if (_closed) {
      socket.close(WebSocketStatus.normalClosure).ignore();
      return;
    }
    _socket = socket;
    socket.listen(
      (data) {
        if (_closed || data is! String) return;
        _messages.add(data);
        onMessage?.call(data);
      },
      onError: (Object _) => onError?.call(),
      // Without a close frame from the server the code is 1006.
      onDone: () => _finish(socket.closeCode ?? WebSocketStatus.abnormalClosure, socket.closeReason ?? ''),
    );
    onOpen?.call();
  }

  @override
  void send(String text) {
    if (isOpen) _socket!.add(text);
  }

  @override
  void sendBytes(List<int> data) {
    if (isOpen) _socket!.add(data);
  }

  @override
  void close() {
    if (_closed) return;
    _closed = true;
    _socket?.close(WebSocketStatus.normalClosure).ignore();
    _done.complete();
    _messages.close();
  }

  void _finish(int code, String reason) {
    if (_closed) return;
    _closed = true;
    onClose?.call(code, reason);
    _done.complete();
    _messages.close();
  }
}
