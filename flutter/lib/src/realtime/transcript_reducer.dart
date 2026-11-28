import 'types.dart';

String _mergePreview(String current, String incoming) {
  final next = incoming.trim();
  if (current.isEmpty || next.startsWith(current)) return next;
  if (next.isEmpty || current.startsWith(next)) return current;
  return next;
}

/// Returns the rows with [event] applied, sorted by `order_seq`. [rows] itself is not changed.
List<TranslationRow> applyResultEvent(List<TranslationRow> rows, ResultEvent event) {
  final existing = rows.where((row) => row.orderSeq == event.orderSeq).firstOrNull;
  final isFinal = event.eventType == ResultEventType.transcriptFinal || event.eventType == ResultEventType.translationFinal;
  final isTranscript = event.eventType == ResultEventType.transcriptPreview || event.eventType == ResultEventType.transcriptFinal;
  final targetLanguage = event.targetLanguage ?? '';
  if (!isTranscript && targetLanguage.isEmpty) return [...rows];
  final current = isTranscript ? existing?.source : existing?.translations[targetLanguage];
  // A final stands: a preview of the same `order_seq` that arrives after it is out of date.
  if (current != null && current.isFinal && !isFinal) return [...rows];

  final text = TranslationText(
    text: !isFinal && current != null ? _mergePreview(current.text, event.text) : event.text,
    isFinal: isFinal,
  );
  final row = TranslationRow(
    orderSeq: event.orderSeq,
    sourceLanguage: isTranscript || existing == null ? event.sourceLanguage : existing.sourceLanguage,
    source: isTranscript ? text : existing?.source,
    translations: {...?existing?.translations, if (!isTranscript) targetLanguage: text},
  );
  return [...rows.where((item) => item.orderSeq != event.orderSeq), row]..sort((a, b) => a.orderSeq.compareTo(b.orderSeq));
}

/// True while a row still expects a final transcript or a final translation.
bool awaitsFinal(TranslationRow row) {
  return !(row.source?.isFinal ?? false) || row.translations.isEmpty || row.translations.values.any((item) => !item.isFinal);
}

/// The `after_order_seq` of a new Result WebSocket: the last `order_seq` up to which every row has
/// its final transcript and its final translation. The server sends the finals stored after it
/// again, so a final missed while the socket was closed still arrives. Null when there is none yet.
int? lastCompleteOrderSeq(List<TranslationRow> rows) {
  int? last;
  for (final row in rows) {
    if (awaitsFinal(row)) break;
    last = row.orderSeq;
  }
  return last;
}
