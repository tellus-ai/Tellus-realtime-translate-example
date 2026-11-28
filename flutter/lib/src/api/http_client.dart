import 'dart:async';
import 'dart:convert';

import 'package:http/http.dart' as http;

class RealtimeApiError implements Exception {
  RealtimeApiError(this.message, this.status, [List<String>? messages]) : messages = messages ?? [message];

  final String message;

  /// The HTTP status, or null when no response arrived.
  final int? status;
  final List<String> messages;

  @override
  String toString() => message;
}

List<String> _readMessages(Object? value) {
  if (value is! Map) return [];
  final message = value['message'];
  if (message is List) return message.whereType<String>().toList();
  if (message is String) return [message];
  // `POST /v1/access-tokens` reports an error as `{"detail": "<text>"}`.
  final detail = value['detail'];
  return detail is String ? [detail] : [];
}

Object? _unwrapEnvelope(Object? value) {
  return value is Map && value.containsKey('data') && value['statusCode'] is String ? value['data'] : value;
}

/// True when nobody answered: the request failed or timed out here (`null`), or this example's
/// server reports that Tellus could not be reached (`502`) or did not answer in time (`504`).
/// Tellus may still have applied such a request.
bool gotNoResponse(int? status) => status == null || status == 502 || status == 504;

// REST error responses carry no Retry-After header, so temporary failures use fixed waits.
const _retryDelays = [Duration(seconds: 1), Duration(seconds: 2), Duration(seconds: 5)];
const _requestTimeout = Duration(seconds: 15);

/// Sends a POST and returns the decoded JSON answer. Sends it again after a 503, up to three more
/// times. Other statuses are not retried.
///
/// [retryNetworkFailure] also retries when no response arrives. Only for requests that are safe to
/// repeat: a create request may have succeeded on the server even though its response was lost.
Future<Object?> postJson(String url, {Object? body, bool retryNetworkFailure = false, http.Client? client}) async {
  for (var attempt = 0; ; attempt += 1) {
    try {
      return await _postOnce(url, body, client);
    } on RealtimeApiError catch (error) {
      // No response includes a request that ran into the request timeout.
      final temporary = error.status == 503 || (gotNoResponse(error.status) && retryNetworkFailure);
      if (!temporary || attempt >= _retryDelays.length) rethrow;
      await Future<void>.delayed(_retryDelays[attempt]);
    }
  }
}

Future<Object?> _postOnce(String url, Object? body, http.Client? client) async {
  // A request without a client from the caller gets its own, like `http.post`.
  final sender = client ?? http.Client();
  final http.Response response;
  try {
    response = await sender
        .post(
          Uri.parse(url),
          // No credential: these calls go to this example's own server, which holds the API key
          // (scripts/conversation-api-middleware.cjs). The header shows that this app sent them.
          headers: {'Content-Type': 'application/json', 'X-Tellus-Example-Api': '1'},
          body: body == null ? null : utf8.encode(jsonEncode(body)),
        )
        .timeout(_requestTimeout);
  } on TimeoutException {
    throw RealtimeApiError('The request timed out.', null);
  } catch (error) {
    throw RealtimeApiError(error is http.ClientException ? error.message : '$error', null);
  } finally {
    // Closing the client also aborts a request that ran into the timeout.
    if (client == null) sender.close();
  }
  final raw = utf8.decode(response.bodyBytes, allowMalformed: true);
  Object? decoded;
  if (raw.isNotEmpty) {
    try {
      decoded = jsonDecode(raw);
    } on FormatException {
      decoded = raw;
    }
  }
  if (response.statusCode < 200 || response.statusCode >= 300) {
    final messages = _readMessages(decoded);
    final fallback = decoded is String && decoded.isNotEmpty ? decoded : 'HTTP ${response.statusCode}';
    throw RealtimeApiError(messages.firstOrNull ?? fallback, response.statusCode, messages);
  }
  return _unwrapEnvelope(decoded);
}
