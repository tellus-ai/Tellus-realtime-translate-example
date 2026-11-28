import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
// The SDK lets tests replace its native capture; the example has no other way to run it on the host.
// ignore: implementation_imports
import 'package:tellus_audio_sdk/src/native.dart';
import 'package:tellus_flutter_example/src/audio/native_microphone.dart';

/// Answers every native call at once, except `getStatus` while [statusGate] is set.
class _Native implements NativeCapture {
  Completer<void>? statusGate;
  var destroyed = false;

  @override
  Future<String?> invoke(String method, {String? argument, double number = 0, Uint8List? bytes}) async {
    if (method != 'getStatus') return null;
    await statusGate?.future;
    return jsonEncode({'lifecycle': 'stopped', 'denoise_enabled': false, 'denoise_load_failed': false});
  }

  @override
  bool canDeliver(int epoch, int generation) => true;

  @override
  void acknowledgeChunk() {}

  @override
  void invalidateAuthorization() {}

  @override
  void destroy() => destroyed = true;
}

void main() {
  final natives = <_Native>[];

  setUp(() {
    natives.clear();
    createNativeCapture = (onChunk, onError) {
      final native = _Native();
      natives.add(native);
      return native;
    };
  });

  // The session calls stop() when Stop arrives during `creating`. A prepare() that was still
  // releasing the capture of the last session must not create a new one after that.
  test('creates no capture when stop() arrives while prepare() releases the previous one', () async {
    final microphone = NativeMicrophone();
    await microphone.prepare();
    expect(microphone.audioSdkReady, isTrue);

    final releasing = natives.single.statusGate = Completer<void>();
    final preparing = microphone.prepare();
    await microphone.stop();
    releasing.complete();
    await preparing;

    expect(microphone.audioSdkReady, isFalse);
    expect(natives, hasLength(1));
    expect(natives.single.destroyed, isTrue);
  });
}
