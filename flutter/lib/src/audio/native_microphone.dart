import 'package:tellus_audio_sdk/tellus_audio_sdk.dart';

abstract interface class MicrophoneRecorder {
  bool get audioSdkReady;
  bool get denoiseEnabled;

  /// Returns the setting that is in effect afterwards.
  Future<bool> setDenoiseEnabled(bool enabled);
  Future<void> prepare();

  /// Approves the capture on an open `/v1/audio` socket. [getAccessToken] is called for the first
  /// approval and again for every renewal. [onError] reports an approval that is lost later.
  Future<void> authorize(
    EngineAuthorizationSocket socket,
    String conversationId,
    Future<String> Function() getAccessToken,
    void Function(Object error) onError,
  );
  void releaseAuthorization();
  Future<void> start(void Function(AudioChunk chunk) onFrame, void Function(Object error) onError);
  Future<void> pause();
  Future<void> resume();
  Future<void> stop();
}

/// The SDK capture owns the OS microphone, the DSP and the encoder. The app only passes the
/// encoded payload on.
class NativeMicrophone implements MicrophoneRecorder {
  /// [denoiseEnabled] is the setting before the first Start. The switch on the screen changes it
  /// at any time.
  NativeMicrophone({bool denoiseEnabled = false}) : _denoise = denoiseEnabled;

  AudioCapture? _capture;
  EngineAuthorizationController? _authorization;
  AudioCaptureCallback? _callback;
  int _generation = 0;
  bool _denoise;

  @override
  bool get audioSdkReady => _capture != null;

  @override
  bool get denoiseEnabled => _denoise;

  @override
  Future<bool> setDenoiseEnabled(bool enabled) async {
    final capture = _capture;
    if (capture == null) return _denoise = enabled;
    await capture.setDenoiseEnabled(enabled);
    final status = await capture.getStatus();
    if (!identical(capture, _capture)) return _denoise;
    _denoise = status.denoiseEnabled;
    if (_denoise != enabled) throw StateError('Audio SDK did not apply the requested denoise setting.');
    return _denoise;
  }

  @override
  Future<void> prepare() async {
    // The stop() below counts one generation. Another stop() while it releases the previous
    // capture counts one more, and cancels this prepare.
    final generation = _generation + 1;
    await stop();
    try {
      // When denoise is on, it runs in close_talk mode: a near-speech gate turns sound that is
      // not close to the microphone into silence (about 330 ms more delay). Its tuning values
      // are the engine defaults.
      final engine = await AudioEngine.init(
        AudioCaptureConfig(
          sampleRate: 16000,
          codec: 'opus',
          bitrateBps: 64000,
          denoiseEnabled: _denoise,
          denoiseMode: 'close_talk',
          vadEnabled: false,
          echoCancellationEnabled: true,
        ),
      );
      if (generation != _generation) return;
      final capture = _capture = engine.createCapture();
      final status = await capture.getStatus();
      if (identical(capture, _capture)) _denoise = status.denoiseEnabled;
    } catch (error) {
      // An unavailable SDK becomes a visible session error.
      throw StateError('Audio SDK is required but could not be initialized: $error');
    }
  }

  @override
  Future<void> authorize(
    EngineAuthorizationSocket socket,
    String conversationId,
    Future<String> Function() getAccessToken,
    void Function(Object error) onError,
  ) async {
    final capture = _capture;
    if (capture == null) throw StateError('Audio capture is unavailable.');
    releaseAuthorization();
    final authorization = _authorization = attachEngineAuthorization(
      socket,
      capture,
      conversationId: conversationId,
      getAccessToken: getAccessToken,
      onError: onError,
    );
    await authorization.ready;
  }

  @override
  void releaseAuthorization() {
    _authorization?.dispose();
    _authorization = null;
  }

  @override
  Future<void> start(void Function(AudioChunk chunk) onFrame, void Function(Object error) onError) async {
    final capture = _capture;
    if (capture == null) throw StateError('Audio capture is unavailable.');
    void callback(TellusAudioException? error, AudioChunk? chunk) {
      if (error != null) {
        onError(error);
      } else if (chunk != null) {
        onFrame(chunk);
      }
    }

    _callback = callback;
    await capture.start(callback);
  }

  @override
  Future<void> pause() async {
    await _capture?.pause();
  }

  @override
  Future<void> resume() async {
    final capture = _capture;
    final callback = _callback;
    if (capture == null || callback == null) throw StateError('Unable to resume the microphone stream.');
    final status = await capture.getStatus();
    // Releasing the approval stops the capture, so after a new `/v1/audio` socket it starts again.
    if (status.state == 'stopped') {
      await capture.start(callback);
    } else {
      await capture.resume();
    }
  }

  @override
  Future<void> stop() async {
    ++_generation;
    final capture = _capture;
    _capture = null;
    try {
      final status = await capture?.getStatus();
      if (status?.state == 'running' || status?.state == 'paused') await capture?.stop();
    } finally {
      releaseAuthorization();
      await capture?.dispose();
      _callback = null;
    }
  }
}
