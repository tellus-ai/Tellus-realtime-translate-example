import { describe, expect, it } from 'vitest';
import { parseSocketMessage } from '../src/realtime/resultParser';

const CONVERSATION = { conversation_id: 'conversation-1' };
const TIMES = { speaker_id: '1', start_ms: 1352, end_ms: 6212 };
const parse = (message: object) => parseSocketMessage(JSON.stringify(message));

describe('parseSocketMessage', () => {
  it('reads every utterance of a transcript.final, each with its own order_seq', () => {
    expect(parse({
      type: 'transcript.final',
      data: {
        ...CONVERSATION,
        utterances: [
          { order_seq: 0, transcript: '다음 안건으로 넘어가겠습니다', source_language: 'ko-KR', ...TIMES },
          { order_seq: 1, transcript: " Let's check the budget first.", source_language: 'en-US', ...TIMES },
        ],
      },
    })).toEqual({
      kind: 'result',
      events: [
        {
          conversationId: 'conversation-1', eventType: 'transcript.final', orderSeq: 0,
          text: '다음 안건으로 넘어가겠습니다', sourceLanguage: 'ko-KR', targetLanguage: null,
        },
        {
          conversationId: 'conversation-1', eventType: 'transcript.final', orderSeq: 1,
          text: " Let's check the budget first.", sourceLanguage: 'en-US', targetLanguage: null,
        },
      ],
    });
  });

  it('reads a translation.final by the order_seq and target language of its item', () => {
    expect(parse({
      type: 'translation.final',
      data: {
        ...CONVERSATION,
        translations: [
          { order_seq: 7, translation: 'Hello', source_language: 'ko-KR', target_language: 'en-US', ...TIMES },
        ],
      },
    })).toEqual({
      kind: 'result',
      events: [{
        conversationId: 'conversation-1', eventType: 'translation.final', orderSeq: 7,
        text: 'Hello', sourceLanguage: 'ko-KR', targetLanguage: 'en-US',
      }],
    });
  });

  it('shows the parts of a transcript.preview as one text under the open order_seq', () => {
    expect(parse({
      type: 'transcript.preview',
      data: {
        ...CONVERSATION,
        order_seq: 7,
        utterances: [
          { transcript: '네 그럼 다음 안건으로', source_language: 'ko-KR', ...TIMES },
          { transcript: " Let's check", source_language: 'en-US', ...TIMES },
        ],
      },
    })).toEqual({
      kind: 'result',
      events: [{
        conversationId: 'conversation-1', eventType: 'transcript.preview', orderSeq: 7,
        text: "네 그럼 다음 안건으로 Let's check", sourceLanguage: 'ko-KR', targetLanguage: null,
      }],
    });
  });

  it('groups a translation.preview by target language and skips the empty slots', () => {
    const parsed = parse({
      type: 'translation.preview',
      data: {
        ...CONVERSATION,
        order_seq: 7,
        translations: [
          { translation: 'Then the next item', source_language: 'ko-KR', target_language: 'en-US', ...TIMES },
          { translation: '', source_language: 'en-US', target_language: null, ...TIMES },
          { translation: '예산을 확인합시다', source_language: 'en-US', target_language: 'ko-KR', ...TIMES },
          { translation: 'please', source_language: 'ko-KR', target_language: 'en-US', ...TIMES },
        ],
      },
    });
    expect(parsed).toMatchObject({
      kind: 'result',
      events: [
        { eventType: 'translation.preview', orderSeq: 7, text: 'Then the next item please', targetLanguage: 'en-US' },
        { eventType: 'translation.preview', orderSeq: 7, text: '예산을 확인합시다', targetLanguage: 'ko-KR' },
      ],
    });
  });

  it('keeps a language that the server does not know as null', () => {
    expect(parse({
      type: 'transcript.final',
      data: { ...CONVERSATION, utterances: [{ order_seq: 3, transcript: '...', source_language: null, ...TIMES }] },
    })).toMatchObject({ events: [{ orderSeq: 3, sourceLanguage: null }] });
  });

  it('separates control messages and ignores the types it does not show', () => {
    expect(parseSocketMessage('{"type":"conversation.ended","data":{}}')).toEqual({ kind: 'ended' });
    for (const type of ['settings.updated', 'tts.completed', 'tts.skipped', 'a.type.added.later']) {
      expect(parse({ type, data: { ...CONVERSATION } })).toEqual({ kind: 'ignored' });
    }
    // The shape of the unversioned routes is not a /v1 result.
    expect(parse({ type: 'result', data: { event_type: 'transcript.final', text: '안녕' } })).toEqual({ kind: 'ignored' });
    expect(parse({ type: 'participants.snapshot', data: {} })).toEqual({ kind: 'ignored' });
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

  it('reads retry_after_ms from the /v1/audio reconnect rate limit', () => {
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

  it.each([
    ['no item array', { type: 'transcript.final', data: { ...CONVERSATION } }],
    ['no conversation_id', { type: 'transcript.final', data: { utterances: [] } }],
    ['a final item without order_seq', {
      type: 'transcript.final',
      data: { ...CONVERSATION, utterances: [{ transcript: '안녕', source_language: 'ko-KR' }] },
    }],
    ['a preview without order_seq', {
      type: 'transcript.preview',
      data: { ...CONVERSATION, utterances: [{ transcript: '안녕', source_language: 'ko-KR' }] },
    }],
    ['an item without its text', {
      type: 'translation.final',
      data: { ...CONVERSATION, translations: [{ order_seq: 1, source_language: 'ko-KR', target_language: 'en-US' }] },
    }],
    ['a negative order_seq', {
      type: 'transcript.final',
      data: { ...CONVERSATION, utterances: [{ order_seq: -1, transcript: '안녕', source_language: 'ko-KR' }] },
    }],
  ])('reports a result with %s as an error', (_name, message) => {
    expect(parse(message)).toEqual({ kind: 'error', message: 'Invalid Result WebSocket payload.' });
  });

  it('reports invalid JSON as an error', () => {
    expect(parseSocketMessage('not json')).toEqual({
      kind: 'error',
      message: 'Result WebSocket returned invalid JSON.',
    });
  });
});
