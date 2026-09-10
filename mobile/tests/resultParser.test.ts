import { parseSocketMessage } from '../src/realtime/resultParser';

describe('parseSocketMessage', () => {
  it('parses a result envelope', () => {
    expect(parseSocketMessage(JSON.stringify({
      type: 'result',
      data: {
        conversation_id: 'conversation-1',
        event_type: 'transcript.final',
        order_seq: 3,
        text: '안녕하세요',
        source_language: 'ko-KR',
        target_language: null,
      },
    }))).toEqual({
      kind: 'result',
      event: {
        conversationId: 'conversation-1',
        eventType: 'transcript.final',
        orderSeq: 3,
        text: '안녕하세요',
        sourceLanguage: 'ko-KR',
        targetLanguage: null,
      },
    });
  });
});

