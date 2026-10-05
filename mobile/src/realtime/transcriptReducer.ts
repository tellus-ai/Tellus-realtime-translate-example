import type { ResultEvent, TranslationRow } from './types';

function mergePreview(current: string, incoming: string): string {
  const next = incoming.trim();
  if (!current || next.startsWith(current)) return next;
  if (!next || current.startsWith(next)) return current;
  return next;
}

export function applyResultEvent(rows: readonly TranslationRow[], event: ResultEvent): TranslationRow[] {
  const existing = rows.find((row) => row.orderSeq === event.orderSeq);
  const row: TranslationRow = existing
    ? { ...existing, translations: { ...existing.translations } }
    : { orderSeq: event.orderSeq, sourceLanguage: event.sourceLanguage, source: null, translations: {} };
  const isFinal = event.eventType.endsWith('.final');
  if (event.eventType.startsWith('transcript.')) {
    row.sourceLanguage = event.sourceLanguage;
    row.source = { text: !isFinal && row.source && !row.source.isFinal ? mergePreview(row.source.text, event.text) : event.text, isFinal };
  } else if (event.targetLanguage) {
    const current = row.translations[event.targetLanguage];
    row.translations[event.targetLanguage] = { text: !isFinal && current && !current.isFinal ? mergePreview(current.text, event.text) : event.text, isFinal };
  }
  return [...rows.filter((item) => item.orderSeq !== event.orderSeq), row].sort((a, b) => a.orderSeq - b.orderSeq);
}

/** True while a row still expects a final transcript or a final translation. */
export function awaitsFinal(row: TranslationRow): boolean {
  const translations = Object.values(row.translations);
  return !row.source?.isFinal || translations.length === 0 || translations.some((item) => !item.isFinal);
}

