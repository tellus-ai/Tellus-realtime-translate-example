import 'dart:convert';

import 'close_policy.dart';
import 'types.dart';

const _eventTypes = {
  'transcript.preview': ResultEventType.transcriptPreview,
  'transcript.final': ResultEventType.transcriptFinal,
  'translation.preview': ResultEventType.translationPreview,
  'translation.final': ResultEventType.translationFinal,
};

sealed class ParsedSocketMessage {
  const ParsedSocketMessage();
}

/// A `result` can update several rows: a final can carry several utterances.
final class ParsedResult extends ParsedSocketMessage {
  const ParsedResult(this.events);

  final List<ResultEvent> events;
}

final class ParsedEnded extends ParsedSocketMessage {
  const ParsedEnded();
}

final class ParsedSystemError extends ParsedSocketMessage {
  const ParsedSystemError(this.error);

  final SystemError error;
}

final class ParsedError extends ParsedSocketMessage {
  const ParsedError(this.message);

  final String message;
}

final class ParsedIgnored extends ParsedSocketMessage {
  const ParsedIgnored();
}

bool _isOrderSeq(Object? value) => value is int && value >= 0;

ParsedSocketMessage parseSocketMessage(String raw) {
  final Object? payload;
  try {
    payload = jsonDecode(raw);
  } on FormatException {
    return const ParsedError('Result WebSocket returned invalid JSON.');
  }
  if (payload is! Map<String, dynamic>) return const ParsedIgnored();
  final type = payload['type'];
  if (type == 'conversation.ended') return const ParsedEnded();
  if (type == 'system.error') {
    final message = payload['message'];
    final messages = message is List ? message.whereType<String>() : const <String>[];
    final data = payload['data'];
    final reason = data is Map ? data['reason'] : null;
    final retryAfterMs = data is Map ? data['retry_after_ms'] : null;
    return ParsedSystemError(
      SystemError(
        code: int.tryParse('${payload['statusCode']}'),
        reason: reason is String ? reason : null,
        message: messages.firstOrNull ?? 'Realtime connection error.',
        retryAfterMs: retryAfterMs is num && retryAfterMs.isFinite && retryAfterMs >= 0 ? retryAfterMs.round() : null,
      ),
    );
  }
  // `settings.updated`, `tts.completed`, `tts.skipped`, and any type added later.
  if (type is! String || !_eventTypes.containsKey(type)) return const ParsedIgnored();
  final events = _readResultEvents(type, payload['data']);
  return events == null ? const ParsedError('Invalid Result WebSocket payload.') : ParsedResult(events);
}

typedef _Item = ({Object? orderSeq, String text, String? sourceLanguage, String? targetLanguage});

/// Results arrive as item arrays: `data.utterances[]` for a transcript and `data.translations[]`
/// for a translation. Returns null when the message does not have that shape.
List<ResultEvent>? _readResultEvents(String type, Object? data) {
  if (data is! Map<String, dynamic>) return null;
  final conversationId = data['conversation_id'];
  if (conversationId is! String) return null;
  final eventType = _eventTypes[type]!;
  final isTranscript = type.startsWith('transcript.');
  final textField = isTranscript ? 'transcript' : 'translation';
  final items = data[isTranscript ? 'utterances' : 'translations'];
  if (items is! List) return null;
  final entries = <_Item>[];
  for (final item in items) {
    if (item is! Map<String, dynamic>) return null;
    final text = item[textField];
    // Languages are always present, and null when the server does not know them.
    final sourceLanguage = item['source_language'];
    final targetLanguage = item['target_language'];
    if (text is! String || sourceLanguage is! String? || targetLanguage is! String?) return null;
    entries.add((
      orderSeq: item['order_seq'],
      text: text,
      sourceLanguage: sourceLanguage,
      // A transcript has no target language.
      targetLanguage: isTranscript ? null : targetLanguage,
    ));
  }
  // A translation item without a target language is an empty slot that only keeps the items in
  // line with the transcript preview.
  final usable = isTranscript ? entries : entries.where((entry) => entry.targetLanguage != null).toList();

  if (type.endsWith('.final')) {
    // Each item of a final carries its own `order_seq`.
    if (!usable.every((entry) => _isOrderSeq(entry.orderSeq))) return null;
    return [
      for (final entry in usable)
        ResultEvent(
          conversationId: conversationId,
          eventType: eventType,
          orderSeq: entry.orderSeq as int,
          text: entry.text,
          sourceLanguage: entry.sourceLanguage,
          targetLanguage: entry.targetLanguage,
        ),
    ];
  }

  // A preview replaces the open `order_seq` as a whole. The server splits it where the language
  // or the speaker changes; this example shows the parts as one text per target language.
  final orderSeq = data['order_seq'];
  if (orderSeq is! int || orderSeq < 0) return null;
  final byTargetLanguage = <String?, List<_Item>>{};
  for (final entry in usable) {
    (byTargetLanguage[entry.targetLanguage] ??= []).add(entry);
  }
  return [
    for (final MapEntry(key: targetLanguage, value: parts) in byTargetLanguage.entries)
      ResultEvent(
        conversationId: conversationId,
        eventType: eventType,
        orderSeq: orderSeq,
        text: parts.map((part) => part.text.trim()).where((text) => text.isNotEmpty).join(' '),
        sourceLanguage: parts.first.sourceLanguage,
        targetLanguage: targetLanguage,
      ),
  ];
}
