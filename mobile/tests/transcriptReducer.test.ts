import { applyResultEvent } from '../src/realtime/transcriptReducer';
import type { ResultEvent } from '../src/realtime/types';

const base: ResultEvent = {
  conversationId: 'c1',
  eventType: 'transcript.final',
  orderSeq: 1,
  text: '안녕하세요',
  sourceLanguage: 'ko-KR',
  targetLanguage: null,
};

describe('applyResultEvent', () => {
  it('pairs transcript and translation by order sequence', () => {
    let rows = applyResultEvent([], base);
    rows = applyResultEvent(rows, {
      ...base,
      eventType: 'translation.final',
      text: 'Hello',
      targetLanguage: 'en-US',
    });
    expect(rows[0]?.source?.text).toBe('안녕하세요');
    expect(rows[0]?.translations['en-US']?.text).toBe('Hello');
  });
});

