import type { ResultEvent, ResultEventType } from '../shared/realtimeTypes';
import type { SystemError } from './closePolicy';

const EVENT_TYPES = new Set<string>([
  'transcript.preview',
  'transcript.final',
  'translation.preview',
  'translation.final',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isOrderSeq(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

/** Languages are always present, and null when the server does not know them. */
function isLanguage(value: unknown): value is string | null | undefined {
  return value === null || value === undefined || typeof value === 'string';
}

export type ParsedSocketMessage =
  /** A result message. A final can carry several utterances, so it can update several rows. */
  | { kind: 'result'; events: ResultEvent[] }
  | { kind: 'ended' }
  | { kind: 'system-error'; error: SystemError }
  | { kind: 'error'; message: string }
  | { kind: 'ignored' };

export function parseSocketMessage(raw: unknown): ParsedSocketMessage {
  let payload: unknown = raw;
  if (typeof raw === 'string') {
    try {
      payload = JSON.parse(raw);
    } catch {
      return { kind: 'error', message: 'Result WebSocket returned invalid JSON.' };
    }
  }
  if (!isRecord(payload)) return { kind: 'ignored' };
  if (payload.type === 'conversation.ended') return { kind: 'ended' };
  if (payload.type === 'system.error') {
    const messages = Array.isArray(payload.message)
      ? payload.message.filter((item): item is string => typeof item === 'string')
      : [];
    const data = isRecord(payload.data) ? payload.data : {};
    const code = Number.parseInt(String(payload.statusCode), 10);
    const retryAfterMs = data.retry_after_ms;
    return {
      kind: 'system-error',
      error: {
        code: Number.isNaN(code) ? null : code,
        reason: typeof data.reason === 'string' ? data.reason : null,
        message: messages[0] ?? 'Realtime connection error.',
        retryAfterMs:
          typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
            ? retryAfterMs
            : null,
      },
    };
  }
  // `settings.updated`, `tts.completed`, `tts.skipped`, and any type added later.
  if (typeof payload.type !== 'string' || !EVENT_TYPES.has(payload.type)) return { kind: 'ignored' };

  const events = readResultEvents(payload.type as ResultEventType, payload.data);
  return events
    ? { kind: 'result', events }
    : { kind: 'error', message: 'Invalid Result WebSocket payload.' };
}

/**
 * Results arrive as item arrays: `data.utterances[]` for a transcript and `data.translations[]`
 * for a translation. Returns null when the message does not have that shape.
 */
function readResultEvents(eventType: ResultEventType, data: unknown): ResultEvent[] | null {
  if (!isRecord(data) || typeof data.conversation_id !== 'string') return null;
  const conversationId = data.conversation_id;
  const isTranscript = eventType.startsWith('transcript.');
  const textField = isTranscript ? 'transcript' : 'translation';
  const items = isTranscript ? data.utterances : data.translations;
  if (!Array.isArray(items)) return null;
  for (const item of items) {
    if (
      !isRecord(item) ||
      typeof item[textField] !== 'string' ||
      !isLanguage(item.source_language) ||
      !isLanguage(item.target_language)
    ) {
      return null;
    }
  }
  const entries = (items as Record<string, unknown>[]).map((item) => ({
    orderSeq: item.order_seq,
    text: item[textField] as string,
    sourceLanguage: (item.source_language as string | null | undefined) ?? null,
    // A transcript has no target language.
    targetLanguage: isTranscript ? null : (item.target_language as string | null | undefined) ?? null,
  }));
  // A translation item without a target language is an empty slot that only keeps the items in
  // line with the transcript preview.
  const usable = isTranscript ? entries : entries.filter((entry) => entry.targetLanguage !== null);

  if (eventType.endsWith('.final')) {
    // Each item of a final carries its own `order_seq`.
    if (!usable.every((entry) => isOrderSeq(entry.orderSeq))) return null;
    return usable.map((entry) => ({
      conversationId,
      eventType,
      orderSeq: entry.orderSeq as number,
      text: entry.text,
      sourceLanguage: entry.sourceLanguage,
      targetLanguage: entry.targetLanguage,
    }));
  }

  // A preview replaces the open `order_seq` as a whole. The server splits it where the language
  // or the speaker changes; this example shows the parts as one text per target language.
  if (!isOrderSeq(data.order_seq)) return null;
  const orderSeq = data.order_seq;
  const byTargetLanguage = new Map<string | null, typeof usable>();
  for (const entry of usable) {
    byTargetLanguage.set(entry.targetLanguage, [...(byTargetLanguage.get(entry.targetLanguage) ?? []), entry]);
  }
  return [...byTargetLanguage].map(([targetLanguage, parts]) => ({
    conversationId,
    eventType,
    orderSeq,
    text: parts.map((part) => part.text.trim()).filter(Boolean).join(' '),
    sourceLanguage: parts[0].sourceLanguage,
    targetLanguage,
  }));
}
