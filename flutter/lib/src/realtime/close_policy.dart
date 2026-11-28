// What to do when a realtime WebSocket closes. The rules follow
// "Close codes and recommended client behavior" in the root README.

import 'dart:math';

/// A `system.error` message. The server sends one right before most error closes.
class SystemError {
  const SystemError({required this.code, required this.reason, required this.message, required this.retryAfterMs});

  /// `statusCode`: the close code that follows.
  final int? code;

  /// `data.reason`: a stable code. The close frame repeats it as its reason text.
  final String? reason;

  /// `message[0]`, for display.
  final String message;

  /// `data.retry_after_ms`, sent with the `/v1/audio` reconnect rate limit.
  final int? retryAfterMs;
}

sealed class CloseDecision {
  const CloseDecision(this.reason);

  final String? reason;
}

/// The Conversation is over. Show it as ended; do not reconnect and do not call `POST /end`.
final class CloseEnded extends CloseDecision {
  const CloseEnded(super.reason);
}

/// The server refused the connection. Stop and show [message]; reconnecting does not help.
final class CloseFail extends CloseDecision {
  const CloseFail(super.reason, {required this.message, required this.endConversation});

  final String message;
  final bool endConversation;
}

final class CloseReconnect extends CloseDecision {
  const CloseReconnect(super.reason, {required this.delayMs});

  final int delayMs;
}

const reconnectDelaysMs = [1000, 2000, 5000, 10000, 30000];
// The server can close a socket right after accepting it, so an open socket alone does not
// reset the backoff.
const stableConnectionMs = 30000;

const _endedReasons = {'conversation_ended', 'conversation_not_found'};
// A newer connection for the same Conversation took over this socket.
const _replacedMessages = {
  'audio_connection_replaced': 'Another device or tab took over the audio of this Conversation.',
  'results_connection_replaced': 'Another device or tab took over the results of this Conversation.',
};
// The server rechecks the API key while a socket is open and closes it with this code once the
// key is revoked, expired, or changes scope. No `system.error` precedes it.
const _apiKeyRejectedCode = 4401;

int reconnectDelayMs(int attempt) => reconnectDelaysMs[attempt.clamp(0, reconnectDelaysMs.length - 1)];

/// [code] and [reason] are those of the close frame. [lastError] is the last `system.error`
/// received on the socket that closed. [attempt] counts the reconnects scheduled since the
/// connection last stayed open for [stableConnectionMs].
CloseDecision decideSocketClose({
  required int code,
  required String reason,
  required SystemError? lastError,
  required int attempt,
  double Function()? random,
}) {
  // A connection can end without the server's close frame reaching this client.
  // The preceding `system.error` preserves the intended code and rejection reason.
  final effectiveCode = lastError?.code ?? code;
  final errorReason = lastError?.reason ?? '';
  final effectiveReason = errorReason.isNotEmpty ? errorReason : (reason.isNotEmpty ? reason : null);

  if (effectiveCode == 1000) return CloseEnded(effectiveReason);

  if (effectiveCode == 1008) {
    if (_endedReasons.contains(effectiveReason)) return CloseEnded(effectiveReason);
    final replaced = _replacedMessages[effectiveReason];
    if (replaced != null) {
      // The Conversation is still in use there, so this client leaves it open.
      return CloseFail(effectiveReason, message: replaced, endConversation: false);
    }
    return CloseFail(effectiveReason, message: _describeRejection(code, lastError, effectiveReason), endConversation: true);
  }

  if (effectiveCode == _apiKeyRejectedCode) {
    return CloseFail(
      effectiveReason,
      message: 'The server no longer accepts the API key. (${effectiveReason ?? effectiveCode})',
      endConversation: true,
    );
  }

  // 1012 is a server restart: spread the first reconnect so clients do not return at once.
  if (effectiveCode == 1012 && attempt == 0) {
    final spread = (random ?? Random().nextDouble)();
    return CloseReconnect(effectiveReason, delayMs: 500 + (spread * 1500).floor());
  }

  // Every other code is temporary, including 1006 (no close frame) and codes added later.
  return CloseReconnect(effectiveReason, delayMs: max(reconnectDelayMs(attempt), lastError?.retryAfterMs ?? 0));
}

String _describeRejection(int code, SystemError? lastError, String? reason) {
  if (reason == 'engine_authentication_invalid') {
    return "Audio engine authorization was rejected (1008: engine_authentication_invalid). Check that the server supports this SDK's authorization request and model-key protocol.";
  }
  final message = lastError?.message ?? '';
  if (message.isNotEmpty) return reason == null ? message : '$message ($reason)';
  return 'The server refused the connection. (${reason ?? code})';
}
