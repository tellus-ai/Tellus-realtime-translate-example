import { describe, expect, it } from 'vitest';
import { parseSocketMessage } from '../src/realtime/resultParser';

describe('parseSocketMessage', () => {
  it('parses a result envelope', () => {
    const result = parseSocketMessage(JSON.stringify({
      type: 'result',
      data: {
        conversation_id: 'conversation-1',
        event_type: 'translation.final',
        order_seq: 7,
        text: 'Hello',
        source_language: 'ko-KR',
        target_language: 'en-US',
      },
    }));
    expect(result).toEqual({
      kind: 'result',
      event: {
        conversationId: 'conversation-1',
        eventType: 'translation.final',
        orderSeq: 7,
        text: 'Hello',
        sourceLanguage: 'ko-KR',
        targetLanguage: 'en-US',
      },
    });
  });

  it('separates control messages', () => {
    expect(parseSocketMessage('{"type":"participants.snapshot","data":{}}')).toEqual({ kind: 'ready' });
    expect(parseSocketMessage('{"type":"conversation.ended","data":{}}')).toEqual({ kind: 'ended' });
    expect(parseSocketMessage('{"type":"participant.joined","data":{}}')).toEqual({ kind: 'ignored' });
  });

  it('reads the reason and message of a system.error', () => {
    expect(parseSocketMessage(JSON.stringify({
      type: 'system.error',
      statusCode: '1008',
      message: ['Conversation not found.', '대화를 찾을 수 없습니다.'],
      data: { reason: 'conversation_not_found' },
    }))).toEqual({
      kind: 'system-error',
      error: {
        code: 1008,
        reason: 'conversation_not_found',
        message: 'Conversation not found.',
        retryAfterMs: null,
      },
    });
  });

  it('reads retry_after_ms from the /audio reconnect rate limit', () => {
    const rateLimited = (retryAfterMs: unknown) => parseSocketMessage(JSON.stringify({
      type: 'system.error',
      statusCode: '1013',
      message: ['Audio pipeline reconnect rate limit exceeded.'],
      data: { reason: 'audio_pipeline_activation_rate_limited', retry_after_ms: retryAfterMs },
    }));
    expect(rateLimited(800)).toMatchObject({ error: { code: 1013, retryAfterMs: 800 } });
    expect(rateLimited(0)).toMatchObject({ error: { retryAfterMs: 0 } });
    expect(rateLimited(-1)).toMatchObject({ error: { retryAfterMs: null } });
    expect(rateLimited('800')).toMatchObject({ error: { retryAfterMs: null } });
  });

  it('keeps a system.error that has no reason, message, or status code', () => {
    expect(parseSocketMessage('{"type":"system.error"}')).toEqual({
      kind: 'system-error',
      error: { code: null, reason: null, message: 'Realtime connection error.', retryAfterMs: null },
    });
  });

  it('still reports an invalid result payload as an error', () => {
    expect(parseSocketMessage('{"type":"result","data":{"event_type":"transcript.final"}}')).toEqual({
      kind: 'error',
      message: 'Invalid Result WebSocket payload.',
    });
    expect(parseSocketMessage('not json')).toEqual({
      kind: 'error',
      message: 'Result WebSocket returned invalid JSON.',
    });
  });
});

