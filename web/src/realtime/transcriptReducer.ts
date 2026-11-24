import type { ResultEvent, TranslationRow } from './types';

function mergePreview(current: string, incoming: string): string {
  const next = incoming.trim();
  if (!current || next.startsWith(current)) return next;
  if (!next || current.startsWith(next)) return current;
  return next;
}

export function applyResultEvent(
  rows: readonly TranslationRow[],
  event: ResultEvent,
): TranslationRow[] {
  const existing = rows.find((row) => row.orderSeq === event.orderSeq);
  const isFinal = event.eventType.endsWith('.final');
  const isTranscript = event.eventType.startsWith('transcript.');
  const current = isTranscript
    ? existing?.source
    : event.targetLanguage ? existing?.translations[event.targetLanguage] : undefined;
  // A final stands: a preview of the same `order_seq` that arrives after it is out of date.
  if ((!isTranscript && !event.targetLanguage) || (current?.isFinal && !isFinal)) return [...rows];

  const row: TranslationRow = existing
    ? { ...existing, translations: { ...existing.translations } }
    : {
        orderSeq: event.orderSeq,
        sourceLanguage: event.sourceLanguage,
        source: null,
        translations: {},
      };
  const text = {
    text: !isFinal && current ? mergePreview(current.text, event.text) : event.text,
    isFinal,
  };
  if (isTranscript) {
    row.sourceLanguage = event.sourceLanguage;
    row.source = text;
  } else {
    row.translations[event.targetLanguage!] = text;
  }

  return [...rows.filter((item) => item.orderSeq !== event.orderSeq), row].sort(
    (left, right) => left.orderSeq - right.orderSeq,
  );
}

/** True while a row still expects a final transcript or a final translation. */
export function awaitsFinal(row: TranslationRow): boolean {
  const translations = Object.values(row.translations);
  return !row.source?.isFinal || translations.length === 0 || translations.some((item) => !item.isFinal);
}

/**
 * The `after_order_seq` of a new Result WebSocket: the last `order_seq` up to which every row has
 * its final transcript and its final translation. The server sends the finals stored after it
 * again, so a final missed while the socket was closed still arrives. Null when there is none yet.
 */
export function lastCompleteOrderSeq(rows: readonly TranslationRow[]): number | null {
  let last: number | null = null;
  for (const row of rows) {
    if (awaitsFinal(row)) break;
    last = row.orderSeq;
  }
  return last;
}
