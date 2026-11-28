import 'package:http/http.dart' as http;

import 'http_client.dart';

class RealtimeEndpoints {
  const RealtimeEndpoints({required this.apiBaseUrl, required this.websocketBaseUrl, required this.appOrigin});

  /// This example's own server routes. They forward the calls below to Tellus with the API key, so
  /// that the key is never in the app.
  final String apiBaseUrl;

  /// Tellus itself. The app opens the WebSockets directly, with an access token.
  final String websocketBaseUrl;
  final String appOrigin;
}

class StartConversationInput {
  const StartConversationInput({required this.sourceLanguage, required this.targetLanguage});

  final String sourceLanguage;
  final String targetLanguage;
}

class IssuedAccessToken {
  const IssuedAccessToken({required this.token, required this.expiresAtMs});

  final String token;

  /// Epoch milliseconds. A token lasts 15 minutes.
  final int expiresAtMs;
}

Future<String> createConversation(RealtimeEndpoints endpoints, {http.Client? client}) async {
  // No body: the settings are saved by the next call.
  final response = await postJson('${endpoints.apiBaseUrl}/v1/conversations', client: client);
  final conversationId = response is Map ? response['conversation_id'] : null;
  if (conversationId is! String || conversationId.isEmpty) {
    throw StateError('Conversation response is missing conversation_id.');
  }
  return conversationId;
}

/// Saves the two languages. This example never runs VAD in the app, so `client_vad` is always false.
Future<void> saveInterpretationSettings(
  RealtimeEndpoints endpoints,
  String conversationId,
  String sourceLanguage,
  String targetLanguage, {
  http.Client? client,
}) async {
  await postJson(
    '${endpoints.apiBaseUrl}/v1/conversations/${Uri.encodeComponent(conversationId)}/settings',
    body: {
      'languages': [sourceLanguage, targetLanguage],
      'transcription': {'client_vad': false},
    },
    client: client,
  );
}

/// Asks this example's server for an access token that opens the WebSockets of one Conversation.
/// The token is the only credential the app ever holds.
Future<IssuedAccessToken> issueAccessToken(RealtimeEndpoints endpoints, String conversationId, {http.Client? client}) async {
  final response = await postJson(
    '${endpoints.apiBaseUrl}/v1/access-tokens',
    body: {'session_kind': 'conversation', 'session_id': conversationId},
    // Issuing again is harmless: a token is not stored on the server.
    retryNetworkFailure: true,
    client: client,
  );
  final token = response is Map ? response['access_token'] : null;
  final expiresAtMs = response is Map ? response['expires_at_ms'] : null;
  if (token is! String || token.isEmpty || expiresAtMs is! num || !expiresAtMs.isFinite) {
    throw StateError('Access token response is missing access_token or expires_at_ms.');
  }
  return IssuedAccessToken(token: token, expiresAtMs: expiresAtMs.toInt());
}

/// Completes once the Conversation is over, whether or not this call was the one that ended it.
Future<void> endConversation(RealtimeEndpoints endpoints, String conversationId, {http.Client? client}) async {
  try {
    await postJson(
      '${endpoints.apiBaseUrl}/v1/conversations/${Uri.encodeComponent(conversationId)}/end',
      retryNetworkFailure: true,
      client: client,
    );
  } on RealtimeApiError catch (error) {
    // 410: already ended. 404: gone or expired, so it can no longer be ended.
    if (error.status == 410 || error.status == 404) return;
    rethrow;
  }
}

/// [afterOrderSeq] is the last `order_seq` this client has handled in full. On connect the server
/// first sends the finals stored after it; without it, every stored final.
String buildResultWebSocketUrl(RealtimeEndpoints endpoints, String conversationId, [int? afterOrderSeq]) {
  final url = '${endpoints.websocketBaseUrl}/v1/conversations/${Uri.encodeComponent(conversationId)}/results';
  return afterOrderSeq == null ? url : '$url?after_order_seq=$afterOrderSeq';
}

String buildAudioWebSocketUrl(RealtimeEndpoints endpoints, String conversationId) {
  return '${endpoints.websocketBaseUrl}/v1/audio?conversation_id=${Uri.encodeComponent(conversationId)}&audio_format=opus';
}

/// The handshake headers of both WebSockets. `dart:io` can set them, so the access token goes
/// here rather than into the URL.
Map<String, String> buildWebSocketHeaders(RealtimeEndpoints endpoints, String accessToken) {
  return {'Origin': endpoints.appOrigin, 'Authorization': 'Bearer ${accessToken.trim()}'};
}
