import 'package:http/http.dart' as http;

import 'conversation_api.dart';

// A token this close to its expiry is replaced, so that a connection that is slow to open still
// reaches the server in time.
const _refreshBeforeExpiryMs = 60000;

/// The access tokens of one Conversation, issued by this example's server. A token opens any
/// number of connections to its Conversation until it expires, so one is reused for both
/// WebSockets and for the engine approval on `/v1/audio`. An open WebSocket is not closed when its
/// token expires.
class ConversationAccessTokens {
  ConversationAccessTokens(this._endpoints, this._conversationId, {this._client, this._now = DateTime.now});

  final RealtimeEndpoints _endpoints;
  final String _conversationId;
  final http.Client? _client;
  final DateTime Function() _now;
  IssuedAccessToken? _issued;
  Future<String>? _issuing;

  /// A token that is valid for at least another minute.
  Future<String> get() {
    final issued = _issued;
    if (issued != null && issued.expiresAtMs - _now().millisecondsSinceEpoch > _refreshBeforeExpiryMs) {
      return Future.value(issued.token);
    }
    // Callers that ask while a token is being issued share that one.
    return _issuing ??= issueAccessToken(_endpoints, _conversationId, client: _client)
        .then((issued) {
          _issued = issued;
          return issued.token;
        })
        .whenComplete(() {
          _issuing = null;
        });
  }
}
