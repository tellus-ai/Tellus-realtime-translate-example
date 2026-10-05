import type { ResultEvent, ResultEventType } from '../shared/realtimeTypes';
import type { SystemError } from './closePolicy';

const EVENT_TYPES = new Set<ResultEventType>([
  'transcript.preview',
  'transcript.final',
  'translation.preview',
  'translation.final',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type ParsedSocketMessage =
  | { kind: 'result'; event: ResultEvent }
  /** `participants.snapshot`: the first message on the Result WebSocket. */
  | { kind: 'ready' }
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
  if (payload.type === 'participants.snapshot') return { kind: 'ready' };
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
  if (payload.type !== 'result' || !isRecord(payload.data)) return { kind: 'ignored' };

  const data = payload.data;
  const eventType = data.event_type;
  const targetLanguage = data.target_language;
  if (
    typeof eventType !== 'string' ||
    !EVENT_TYPES.has(eventType as ResultEventType) ||
    typeof data.conversation_id !== 'string' ||
    !Number.isInteger(data.order_seq) ||
    (data.order_seq as number) < 0 ||
    typeof data.text !== 'string' ||
    typeof data.source_language !== 'string' ||
    (targetLanguage !== null && targetLanguage !== undefined && typeof targetLanguage !== 'string')
  ) {
    return { kind: 'error', message: 'Invalid Result WebSocket payload.' };
  }
  if (eventType.startsWith('translation.') && typeof targetLanguage !== 'string') {
    return { kind: 'error', message: 'Translation result is missing target_language.' };
  }

  return {
    kind: 'result',
    event: {
      conversationId: data.conversation_id,
      eventType: eventType as ResultEventType,
      orderSeq: data.order_seq as number,
      text: data.text,
      sourceLanguage: data.source_language,
      targetLanguage: typeof targetLanguage === 'string' ? targetLanguage : null,
    },
  };
}
