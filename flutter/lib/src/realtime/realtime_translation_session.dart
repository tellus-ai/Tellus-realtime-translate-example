import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:tellus_audio_sdk/tellus_audio_sdk.dart';

import '../api/access_tokens.dart';
import '../api/conversation_api.dart';
import '../api/http_client.dart';
import '../audio/native_microphone.dart';
import '../audio/ogg_opus_recording.dart';
import 'close_policy.dart';
import 'realtime_socket.dart';
import 'result_parser.dart';
import 'transcript_reducer.dart';
import 'types.dart';

const _socketOpenTimeout = Duration(seconds: 10);
const _lastFinalTimeout = Duration(seconds: 2);
const _conversationEndedTimeout = Duration(seconds: 5);

/// The phases in which no Conversation is open.
const _overPhases = {SessionPhase.idle, SessionPhase.ended, SessionPhase.error};

/// A socket that is not usable yet: `/v1/audio` before its engine approval, Result before it opens.
typedef _PendingOpen = ({Timer timeout, Completer<bool> usable});

// Marks an argument of `_update` that was not passed, for the fields where null is a value.
const _unchanged = Object();

/// The text of an error for the screen: `toString()` without the type name that Dart puts in front.
String errorText(Object error) => switch (error) {
  StateError(:final message) => message,
  ArgumentError(:final message) => '$message',
  TellusAudioException(:final code, :final engineMessage) => engineMessage == null || engineMessage.isEmpty ? code : '$code ($engineMessage)',
  _ => '$error',
};

/// Waits for [operation] and ignores its failure.
Future<void> _ignoreFailure(Future<void> operation) => operation.catchError((Object _) {});

/// One Conversation at a time: creates it, opens its two WebSockets, sends the microphone audio
/// and collects the results. Everything the screen shows is in [snapshot].
class RealtimeTranslationSession {
  /// The named parameters replace the network and the clock in tests.
  RealtimeTranslationSession(
    this._endpoints,
    this._microphone, {
    this._httpClient,
    this._connectSocket = IoRealtimeSocket.new,
    this._now = DateTime.now,
  }) : _snapshot = SessionSnapshot(denoise: DenoiseSnapshot(enabled: _microphone.denoiseEnabled));

  final RealtimeEndpoints _endpoints;
  final MicrophoneRecorder _microphone;
  final http.Client? _httpClient;
  final RealtimeSocketConnector _connectSocket;
  final DateTime Function() _now;
  DateTime? _microphoneRestartedAt;

  SessionSnapshot _snapshot;
  final _listeners = <void Function()>{};
  final _recording = OggOpusRecording();
  final _sockets = <SocketKind, RealtimeSocket>{};
  // The app has no API key: both sockets open with an access token from this example's server.
  ConversationAccessTokens? _accessTokens;
  // The server explains an error close with a `system.error` just before it.
  final _lastSocketError = <SocketKind, SystemError>{};
  final _pendingOpen = <SocketKind, _PendingOpen>{};
  // Closed sockets that the next reconnect attempt reopens.
  final _socketsToReopen = <SocketKind>{};
  int _reconnectAttempt = 0;
  Timer? _reconnectTimer;
  Future<void> _reconnectQueue = Future.value();
  Future<void>? _reconnectPreparation;
  Timer? _stableTimer;
  // True once Stop, a failure, or the end of the Conversation started closing the session.
  bool _intentionalClose = false;
  // The `POST /end` that a failure started and that is still running. `stop()` waits for it.
  Future<void>? _pendingEnd;
  int _generation = 0;
  int _sampleCursor = 0;
  int _statusSequence = 0;
  bool _desiredPaused = false;
  Future<void> _lifecycleQueue = Future.value();
  bool _acceptingAudio = false;
  Timer? _audioCloseTimer;

  SessionSnapshot get snapshot => _snapshot;

  /// Calls [listener] after every snapshot change. Returns the function that removes it.
  void Function() subscribe(void Function() listener) {
    _listeners.add(listener);
    return () => _listeners.remove(listener);
  }

  /// The audio captured in the last session. Throws a [StateError] while a session is running,
  /// and when nothing was captured.
  AudioRecordingFile getRecording() {
    if (!_isOver) throw StateError('Stop the session before downloading audio.');
    return _recording.getFile();
  }

  Future<void> setDenoiseEnabled(bool enabled) {
    final phase = _snapshot.phase;
    if (_snapshot.denoise.updating || !(_isOver || phase == SessionPhase.recording || phase == SessionPhase.paused)) {
      return Future.value();
    }
    final generation = _generation;
    final before = _snapshot.denoise;
    _update(denoise: DenoiseSnapshot(enabled: before.enabled, applied: before.applied, updating: true));
    return _enqueueLifecycle(() async {
      // The session ended meanwhile, and its cleanup has unlocked the switch. The microphone
      // keeps whatever setting it ended up with for the next Start, so the switch shows that.
      void keepMicrophoneSetting() {
        final denoise = _snapshot.denoise;
        _update(
          denoise: DenoiseSnapshot(
            enabled: _microphone.denoiseEnabled,
            applied: denoise.applied,
            updating: denoise.updating,
            error: denoise.error,
          ),
        );
      }

      try {
        final applied = await _microphone.setDenoiseEnabled(enabled);
        if (generation != _generation) return keepMicrophoneSetting();
        _update(denoise: DenoiseSnapshot(enabled: applied, applied: _snapshot.audioSdkReady ? applied : null));
      } catch (error) {
        if (generation != _generation) return keepMicrophoneSetting();
        final denoise = _snapshot.denoise;
        _update(
          denoise: DenoiseSnapshot(
            enabled: denoise.enabled,
            applied: denoise.applied,
            error: 'Unable to change Audio SDK denoise: ${errorText(error)}',
          ),
        );
      }
    });
  }

  /// Throws when the input cannot start a Conversation. Failures after that are in [snapshot].
  Future<void> start(StartConversationInput input) async {
    if (_endpoints.apiBaseUrl.isEmpty) {
      throw StateError("Set TELLUS_EXAMPLE_API_URL in flutter/.env, or run this example's development server (npm start).");
    }
    if (input.sourceLanguage.isEmpty || input.targetLanguage.isEmpty) throw ArgumentError('Select two languages.');
    if (input.sourceLanguage == input.targetLanguage) throw ArgumentError('Select two different languages.');
    if (!_isOver || _snapshot.denoise.updating) return;
    final generation = ++_generation;
    _intentionalClose = false;
    _recording.reset();
    _reconnectAttempt = 0;
    _microphoneRestartedAt = null;
    _sampleCursor = 0;
    _statusSequence = 0;
    _desiredPaused = false;
    _acceptingAudio = false;
    _update(
      phase: SessionPhase.creating,
      rows: const [],
      error: null,
      conversationId: null,
      audioSdkReady: false,
      recordingAvailable: false,
      denoise: DenoiseSnapshot(enabled: _snapshot.denoise.enabled, updating: _snapshot.denoise.updating),
    );
    try {
      await _microphone.prepare();
      if (generation != _generation) return;
      if (!_microphone.audioSdkReady) throw StateError('Audio SDK is required. Non-SDK audio capture is not supported.');
      final denoise = _snapshot.denoise;
      _update(
        audioSdkReady: true,
        denoise: DenoiseSnapshot(
          enabled: denoise.enabled,
          applied: _microphone.denoiseEnabled,
          updating: denoise.updating,
          error: denoise.error,
        ),
      );
      final conversationId = await createConversation(_endpoints, client: _httpClient);
      if (generation != _generation) {
        await _ignoreFailure(endConversation(_endpoints, conversationId, client: _httpClient));
        return;
      }
      _update(phase: SessionPhase.configuring, conversationId: conversationId);
      await saveInterpretationSettings(
        _endpoints,
        conversationId,
        input.sourceLanguage,
        input.targetLanguage,
        client: _httpClient,
      );
      if (generation != _generation) return;
      _update(phase: SessionPhase.connecting);
      _accessTokens = ConversationAccessTokens(_endpoints, conversationId, client: _httpClient, now: _now);
      final accessToken = await _currentAccessToken();
      if (generation != _generation) return;
      // The server accepts the sockets in either order. Result goes first here, so that it is
      // open before the first audio. A socket that does not become usable has already failed
      // the start in `_handleSocketClose`.
      if (!await _openSocket(SocketKind.result, conversationId, accessToken) || generation != _generation) return;
      if (!await _openSocket(SocketKind.audio, conversationId, accessToken) || generation != _generation) return;
      // A new `/v1/audio` socket counts samples from 0.
      _sampleCursor = 0;
      _sendAudioStatus('capturing');
      _update(phase: SessionPhase.recording);
      _acceptingAudio = true;
      await _microphone.start(_handleAudioFrame, (error) => _handleMicrophoneError(error, generation));
      // The session ended while the microphone was starting. Nothing else stops it now.
      if (generation != _generation) {
        await _ignoreFailure(_microphone.stop());
        return;
      }
      // Pause or a `/v1/audio` close arrived while the microphone was starting.
      if (_snapshot.phase != SessionPhase.recording) await _ignoreFailure(_microphone.pause());
    } catch (error) {
      if (generation != _generation) return;
      _failActiveSession(errorText(error));
    }
  }

  /// iOS stops its audio engine when the audio hardware changes, for example its sample rate. The
  /// approval is still valid, so the microphone is started again, once a minute at most. Any other
  /// capture error ends the session.
  void _handleMicrophoneError(Object error, int generation) {
    if (generation != _generation || _intentionalClose) return;
    final now = _now();
    final restarted = _microphoneRestartedAt;
    if (error is TellusAudioException && error.code == 'audio_configuration_changed' &&
        _snapshot.phase == SessionPhase.recording &&
        (restarted == null || now.difference(restarted) >= const Duration(minutes: 1))) {
      _microphoneRestartedAt = now;
      unawaited(_enqueueLifecycle(() async {
        if (generation != _generation || _intentionalClose || _snapshot.phase != SessionPhase.recording) return;
        try {
          await _microphone.resume();
        } catch (failure) {
          if (generation == _generation && !_intentionalClose) _failActiveSession(errorText(failure));
        }
      }));
      return;
    }
    _failActiveSession(errorText(error));
  }

  Future<void> pause() => _enqueueLifecycle(_pauseNow);

  Future<void> resume() => _enqueueLifecycle(_resumeNow);

  Future<void> stop() => _enqueueLifecycle(_stopNow);

  bool get _isOver => _overPhases.contains(_snapshot.phase);

  Future<void> _pauseNow() async {
    // `/v1/audio` is down and the microphone is already paused: `_resumeAudio` comes back paused.
    if (_snapshot.phase == SessionPhase.reconnecting) _desiredPaused = true;
    if (_snapshot.phase != SessionPhase.recording) return;
    final generation = _generation;
    _desiredPaused = true;
    _acceptingAudio = false;
    try {
      await _microphone.pause();
      if (generation != _generation || _snapshot.phase != SessionPhase.recording) return;
      _sendAudioStatus('paused');
      _update(phase: SessionPhase.paused);
    } catch (error) {
      if (generation == _generation && !_intentionalClose) _failActiveSession(errorText(error));
    }
  }

  Future<void> _resumeNow() async {
    if (_snapshot.phase != SessionPhase.paused) return;
    final generation = _generation;
    _desiredPaused = false;
    _sendAudioStatus('capturing');
    _update(phase: SessionPhase.recording);
    _acceptingAudio = true;
    try {
      await _microphone.resume();
    } catch (error) {
      if (generation == _generation && !_intentionalClose) _failActiveSession(errorText(error));
      return;
    }
    if (generation != _generation || _intentionalClose || _snapshot.phase != SessionPhase.recording) {
      await _ignoreFailure(_microphone.pause());
    }
  }

  Future<void> _stopNow() async {
    // Nothing to stop, or the session is already closing. A failure can still be ending the
    // Conversation; the caller gets to wait for that.
    if (_intentionalClose || _isOver) {
      await _pendingEnd;
      return;
    }
    ++_generation;
    _intentionalClose = true;
    _update(phase: SessionPhase.stopping);
    // The microphone delivers its last frames before this completes, and they are still sent.
    await _ignoreFailure(_microphone.stop());
    _update(
      audioSdkReady: false,
      denoise: DenoiseSnapshot(enabled: _snapshot.denoise.enabled, error: _snapshot.denoise.error),
    );
    _acceptingAudio = false;
    _sendAudioStatus('idle');
    final conversationId = _snapshot.conversationId;
    // The status above makes the server finish the last utterance; its finals arrive on Result.
    await _waitForSnapshot(
      (snapshot) => snapshot.resultConnection != ConnectionStatus.open || !snapshot.rows.any(awaitsFinal),
      _lastFinalTimeout,
    );
    await _cleanupLocal(keepResultSocket: true);
    try {
      if (conversationId != null) await endConversation(_endpoints, conversationId, client: _httpClient);
      // `conversation.ended` and the HTTP response arrive in either order, and results can
      // still arrive until then. `_handleSocketMessage` closes the socket on `conversation.ended`.
      await _waitForSnapshot((snapshot) => snapshot.resultConnection != ConnectionStatus.open, _conversationEndedTimeout);
      _closeSocket(SocketKind.result);
      _update(phase: SessionPhase.ended);
    } catch (error) {
      _closeSocket(SocketKind.result);
      _update(phase: SessionPhase.error, error: errorText(error));
    }
  }

  /// Completes when the snapshot satisfies [done], or after [timeout].
  Future<void> _waitForSnapshot(bool Function(SessionSnapshot snapshot) done, Duration timeout) {
    if (done(_snapshot)) return Future.value();
    final completer = Completer<void>();
    late final Timer timer;
    late final void Function() unsubscribe;
    void finish() {
      timer.cancel();
      unsubscribe();
      if (!completer.isCompleted) completer.complete();
    }

    timer = Timer(timeout, finish);
    unsubscribe = subscribe(() {
      if (done(_snapshot)) finish();
    });
    return completer.future;
  }

  /// Opens a new socket in place of the current one. Completes with `true` once it is usable: the
  /// engine approval for `/v1/audio`, open for Result. Completes with `false` when it closed,
  /// timed out, or was closed by this client first; whoever closed it has already decided what
  /// happens next.
  Future<bool> _openSocket(SocketKind kind, String conversationId, String accessToken) {
    _closeSocket(kind);
    _lastSocketError.remove(kind);
    final url = kind == SocketKind.result
        // The server first sends the finals stored after `after_order_seq`, then live results.
        ? buildResultWebSocketUrl(_endpoints, conversationId, lastCompleteOrderSeq(_snapshot.rows))
        : buildAudioWebSocketUrl(_endpoints, conversationId);
    // Both sockets need a credential. The access token goes in a header, never in the URL.
    final socket = _connectSocket(url, buildWebSocketHeaders(_endpoints, accessToken));
    _sockets[kind] = socket;
    _setConnection(kind, ConnectionStatus.connecting);
    // Every handler is attached before the socket opens: the server accepts a connection first
    // and can reject it right after with `system.error` and a close.
    socket.onOpen = () {
      _setConnection(kind, ConnectionStatus.open);
      // Neither socket sends a ready message. Result is usable once it is open; `/v1/audio` is
      // usable once the engine approval has arrived.
      if (kind == SocketKind.result) {
        _settleOpen(kind, true);
      } else {
        _pendingOpen[kind]?.timeout.cancel();
        _authorizeAudioSocket(socket, conversationId);
      }
    };
    socket.onMessage = (text) => _handleSocketMessage(kind, text);
    socket.onError = () => _setConnection(kind, ConnectionStatus.error);
    socket.onClose = (code, reason) => _handleSocketClose(kind, code, reason);
    final usable = Completer<bool>();
    // No answer in time is handled like a connection lost without a close frame.
    final timeout = Timer(_socketOpenTimeout, () => _handleSocketClose(kind, 1006, ''));
    _pendingOpen[kind] = (timeout: timeout, usable: usable);
    return usable.future;
  }

  /// Asks the Audio SDK to approve its capture on this socket. Nothing is captured before that.
  void _authorizeAudioSocket(RealtimeSocket socket, String conversationId) {
    void onError(Object error) {
      if (identical(socket, _sockets[SocketKind.audio]) && !_intentionalClose) _handleAuthorizationError(error);
    }

    // The approval is renewed while the socket is open, each time with a current token.
    _microphone.authorize(socket, conversationId, _currentAccessToken, onError).then((_) {
      if (identical(socket, _sockets[SocketKind.audio]) && _audioCloseTimer == null) _settleOpen(SocketKind.audio, true);
    }, onError: onError);
  }

  void _settleOpen(SocketKind kind, bool usable) {
    final pending = _pendingOpen.remove(kind);
    if (pending == null) return;
    pending.timeout.cancel();
    if (usable) _socketsToReopen.remove(kind);
    pending.usable.complete(usable);
  }

  /// Detaches the handlers first, so a late event from this socket cannot touch its replacement.
  void _closeSocket(SocketKind kind) {
    final socket = _sockets.remove(kind);
    if (socket == null) return;
    _settleOpen(kind, false);
    if (kind == SocketKind.audio) {
      _acceptingAudio = false;
      _microphone.releaseAuthorization();
      _audioCloseTimer?.cancel();
      _audioCloseTimer = null;
    }
    socket
      ..onOpen = null
      ..onMessage = null
      ..onClose = null
      ..onError = null
      ..close();
    _setConnection(kind, ConnectionStatus.closed);
  }

  void _setConnection(SocketKind kind, ConnectionStatus status) {
    if (kind == SocketKind.result) {
      _update(resultConnection: status);
    } else {
      _update(audioConnection: status);
    }
  }

  void _handleSocketMessage(SocketKind kind, String raw) {
    final parsed = parseSocketMessage(raw);
    if (parsed is ParsedSystemError) {
      // Not shown yet: the close that follows decides whether this ends the session.
      _lastSocketError[kind] = parsed.error;
      return;
    }
    // Everything else on `/v1/audio` belongs to the engine approval, which the Audio SDK reads.
    if (kind == SocketKind.audio) return;
    switch (parsed) {
      case ParsedResult(:final events):
        // Finals that the server sends again after a reconnect replace the same rows.
        _update(rows: events.fold<List<TranslationRow>>(_snapshot.rows, applyResultEvent));
      case ParsedError(:final message):
        _update(error: message);
      case ParsedEnded():
        // After Stop this is the answer to this client's own `POST /end`, and `_stopNow` goes on.
        if (_intentionalClose) {
          _closeSocket(SocketKind.result);
        } else {
          _finishEnded();
        }
      case ParsedSystemError() || ParsedIgnored():
        break;
    }
  }

  /// Handles a close that this client did not start. `_closeSocket` detaches its own closes.
  void _handleSocketClose(SocketKind kind, int code, String reason) {
    final lastError = _lastSocketError[kind];
    _closeSocket(kind);
    if (_intentionalClose) return;
    final decision = decideSocketClose(code: code, reason: reason, lastError: lastError, attempt: _reconnectAttempt);
    if (decision is CloseFail) {
      _failActiveSession(decision.message, shouldEndConversation: decision.endConversation);
    } else if (_snapshot.phase == SessionPhase.connecting) {
      // Nothing is running yet that a reconnect could resume, so any close fails the start.
      // A Conversation that the server reports as ended needs no `POST /end`.
      final cause = '${kind.name} closed: $code ${decision.reason ?? ''}'.trimRight();
      _failActiveSession(
        'The realtime connection closed while starting. ($cause)',
        shouldEndConversation: decision is CloseReconnect,
      );
    } else if (decision is CloseReconnect) {
      _scheduleReconnect(kind, decision.delayMs);
    } else {
      _finishEnded();
    }
  }

  void _scheduleReconnect(SocketKind kind, int delayMs) {
    _clearStableTimer();
    _socketsToReopen.add(kind);
    if (kind == SocketKind.audio) _suspendAudio();
    _scheduleReconnectAttempt(delayMs);
  }

  void _scheduleReconnectAttempt(int delayMs) {
    // An attempt that is already waiting reopens every closed socket.
    if (_reconnectTimer != null) return;
    _reconnectAttempt += 1;
    _reconnectTimer = Timer(Duration(milliseconds: delayMs), _reconnectNow);
  }

  /// Recording continues while only Result is down, but not without `/v1/audio`.
  void _suspendAudio() {
    _update(phase: SessionPhase.reconnecting);
    _acceptingAudio = false;
    _reconnectPreparation ??= _ignoreFailure(_microphone.pause());
  }

  void _reconnectNow() {
    _clearReconnectTimer();
    // One attempt at a time: a later one must not replace a socket that an earlier one is
    // still opening.
    _reconnectQueue = _reconnectQueue.then((_) => _reconnect()).catchError((Object error) {
      _failActiveSession(errorText(error));
    });
  }

  Future<void> _reconnect() async {
    final conversationId = _snapshot.conversationId;
    final generation = _generation;
    // True when the session is closing, or when a close during this attempt has scheduled the
    // next one. That attempt reopens whatever is still closed, after its own delay.
    bool superseded() => _intentionalClose || generation != _generation || _reconnectTimer != null;
    if (conversationId == null || superseded() || _socketsToReopen.isEmpty) return;
    // The token of the first connection may have expired by now.
    final String accessToken;
    try {
      accessToken = await _currentAccessToken();
    } catch (error) {
      if (!superseded()) _handleAccessTokenFailure(error);
      return;
    }
    if (superseded()) return;
    // Result first, as in `start`.
    if (_socketsToReopen.contains(SocketKind.result)) {
      if (!await _openSocket(SocketKind.result, conversationId, accessToken) || superseded()) return;
    }
    if (_socketsToReopen.contains(SocketKind.audio)) {
      // The microphone has paused before the new socket opens.
      await _reconnectPreparation;
      if (superseded()) return;
      _reconnectPreparation = null;
      // A new `/v1/audio` socket counts samples from 0 again.
      _sampleCursor = 0;
      if (!await _openSocket(SocketKind.audio, conversationId, accessToken)) return;
      await _resumeAudio(generation);
    }
    if (superseded() || _socketsToReopen.isNotEmpty) return;
    // The server can close a socket right after accepting it, so the backoff starts over only
    // after both sockets stayed open for a while.
    _stableTimer = Timer(const Duration(milliseconds: stableConnectionMs), () {
      _stableTimer = null;
      _reconnectAttempt = 0;
    });
  }

  /// For a new socket, and for each engine approval on `/v1/audio`.
  Future<String> _currentAccessToken() {
    return _accessTokens?.get() ?? Future.error(StateError('No Conversation is open.'));
  }

  /// Without a token no socket can be opened. Decides as for a socket that the server closed.
  void _handleAccessTokenFailure(Object error) {
    final status = error is RealtimeApiError ? error.status : null;
    if (status == 404 || status == 410) {
      // The Conversation is gone or has ended.
      _finishEnded();
    } else if (error is RealtimeApiError && (gotNoResponse(status) || status == 503)) {
      // No response, or temporarily unavailable: try again as after a lost connection.
      _scheduleReconnectAttempt(reconnectDelayMs(_reconnectAttempt));
    } else {
      // Anything else, such as an answer without a token, would fail the same way again.
      _failActiveSession(errorText(error));
    }
  }

  Future<void> _resumeAudio(int generation) async {
    // The socket that just opened can already be closed again.
    if (_intentionalClose || generation != _generation || _socketsToReopen.contains(SocketKind.audio)) return;
    // The status goes out before any audio on the new socket.
    _sendAudioStatus(_desiredPaused ? 'paused' : 'capturing');
    _update(phase: _desiredPaused ? SessionPhase.paused : SessionPhase.recording);
    if (_desiredPaused) return;
    _acceptingAudio = true;
    await _microphone.resume();
    // Stop, Pause, or another close arrived while the microphone was resuming.
    if (_intentionalClose || generation != _generation || _snapshot.phase != SessionPhase.recording) {
      await _ignoreFailure(_microphone.pause());
    }
  }

  void _handleAudioFrame(AudioChunk chunk) {
    if (!_isOver) _recording.append(chunk);
    final phase = _snapshot.phase;
    if (!_acceptingAudio || (phase != SessionPhase.recording && phase != SessionPhase.stopping)) return;
    final socket = _sockets[SocketKind.audio];
    if (socket == null || !socket.isOpen || chunk.data.isEmpty) return;
    socket.sendBytes(chunk.data);
    _sampleCursor += chunk.sampleCount;
  }

  /// `mic.state` is `capturing`, `paused` or `idle`. `boundary_sample` is the number of samples
  /// sent on this socket so far.
  void _sendAudioStatus(String state) {
    final socket = _sockets[SocketKind.audio];
    if (socket == null || !socket.isOpen) return;
    _statusSequence += 1;
    socket.send(
      jsonEncode({
        'type': 'audio.status',
        'version': 1,
        'status_seq': _statusSequence,
        'boundary_sample': _sampleCursor,
        'mic': {'state': state},
        // This example does not run VAD in the app.
        'vad': {'enabled': false},
      }),
    );
  }

  /// The engine lost its approval on `/v1/audio`, or never got it.
  void _handleAuthorizationError(Object error) {
    final code = error is TellusAudioException ? error.code : null;
    if (const {
      'engine_authorization_connection_closed',
      'engine_authorization_connection_failed',
      'engine_authorization_server_error',
    }.contains(code)) {
      // The close of the socket follows and decides. If it does not come, the socket is given up.
      _acceptingAudio = false;
      _audioCloseTimer ??= Timer(_socketOpenTimeout, () => _handleSocketClose(SocketKind.audio, 1006, ''));
    } else if (code == 'engine_authorization_timeout' || code == 'engine_authorization_expired') {
      _handleSocketClose(SocketKind.audio, 1006, '');
    } else {
      _failActiveSession(errorText(error));
    }
  }

  /// Stop keeps the Result socket for the last results and `conversation.ended`.
  Future<void> _cleanupLocal({bool keepResultSocket = false}) async {
    _clearReconnectTimer();
    _clearStableTimer();
    _socketsToReopen.clear();
    _reconnectPreparation = null;
    // The sockets go first, so that no event arrives while the rest is released.
    _closeSocket(SocketKind.audio);
    if (!keepResultSocket) _closeSocket(SocketKind.result);
    await _ignoreFailure(_microphone.stop());
    final denoise = _snapshot.denoise;
    _update(
      audioSdkReady: false,
      recordingAvailable: _recording.hasAudio,
      denoise: DenoiseSnapshot(enabled: denoise.enabled, error: denoise.error),
    );
  }

  /// Pause, Resume, Stop and a denoise change run one after the other.
  Future<void> _enqueueLifecycle(Future<void> Function() operation) {
    final result = _lifecycleQueue.then((_) => operation());
    _lifecycleQueue = _ignoreFailure(result);
    return result;
  }

  /// The server reported the end of the Conversation, so there is nothing left for `POST /end`.
  void _finishEnded() {
    _intentionalClose = true;
    ++_generation;
    _cleanupLocal().then((_) => _update(phase: SessionPhase.ended, error: null));
  }

  void _failActiveSession(String message, {bool shouldEndConversation = true}) {
    if (_intentionalClose) return;
    _intentionalClose = true;
    ++_generation;
    final conversationId = _snapshot.conversationId;
    _cleanupLocal().then((_) {
      // The error shows once everything is released. `POST /end` can take several retries, so it
      // runs in the background.
      _update(phase: SessionPhase.error, error: message);
      if (!shouldEndConversation || conversationId == null) return;
      late final Future<void> pendingEnd;
      pendingEnd = _ignoreFailure(endConversation(_endpoints, conversationId, client: _httpClient)).whenComplete(() {
        if (identical(_pendingEnd, pendingEnd)) _pendingEnd = null;
      });
      _pendingEnd = pendingEnd;
    });
  }

  void _clearReconnectTimer() {
    _reconnectTimer?.cancel();
    _reconnectTimer = null;
  }

  void _clearStableTimer() {
    _stableTimer?.cancel();
    _stableTimer = null;
  }

  void _update({
    SessionPhase? phase,
    Object? conversationId = _unchanged,
    ConnectionStatus? resultConnection,
    ConnectionStatus? audioConnection,
    List<TranslationRow>? rows,
    bool? audioSdkReady,
    bool? recordingAvailable,
    DenoiseSnapshot? denoise,
    Object? error = _unchanged,
  }) {
    final current = _snapshot;
    _snapshot = SessionSnapshot(
      phase: phase ?? current.phase,
      conversationId: identical(conversationId, _unchanged) ? current.conversationId : conversationId as String?,
      resultConnection: resultConnection ?? current.resultConnection,
      audioConnection: audioConnection ?? current.audioConnection,
      rows: rows ?? current.rows,
      audioSdkReady: audioSdkReady ?? current.audioSdkReady,
      recordingAvailable: recordingAvailable ?? current.recordingAvailable,
      denoise: denoise ?? current.denoise,
      error: identical(error, _unchanged) ? current.error : error as String?,
    );
    // A copy, because a listener may remove itself while it is called.
    for (final listener in _listeners.toList()) {
      listener();
    }
  }
}
