import { describe, expect, it } from 'vitest';
import { parseSocketMessage } from '../electron/realtime/resultParser';

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
    expect(parseSocketMessage('{"type":"participants.snapshot","data":{}}')).toEqual({ kind: 'ignored' });
    expect(parseSocketMessage('{"type":"conversation.ended","data":{}}')).toEqual({ kind: 'ended' });
  });
});

