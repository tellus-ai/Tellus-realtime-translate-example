import { applyResultEvent, awaitsFinal } from '../src/realtime/transcriptReducer';
import type { ResultEvent } from '../src/realtime/types';

const base: ResultEvent = {
  conversationId: 'c1',
  eventType: 'transcript.final',
  orderSeq: 1,
  text: '안녕하세요',
  sourceLanguage: 'ko-KR',
  targetLanguage: null,
};

function event(overrides: Partial<ResultEvent>): ResultEvent {
  return { ...base, eventType: 'transcript.preview', text: '안녕', ...overrides };
}

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

  it('updates preview and replaces it with final', () => {
    let rows = applyResultEvent([], event({ text: '안녕' }));
    rows = applyResultEvent(rows, event({ text: '안녕하세요' }));
    rows = applyResultEvent(rows, event({ eventType: 'transcript.final', text: '안녕하세요.' }));
    expect(rows[0]?.source).toEqual({ text: '안녕하세요.', isFinal: true });
  });

  it('pairs translation by order sequence and sorts late results', () => {
    let rows = applyResultEvent([], event({ orderSeq: 2, eventType: 'transcript.final' }));
    rows = applyResultEvent(rows, event({ orderSeq: 1, eventType: 'transcript.final', text: '먼저' }));
    rows = applyResultEvent(rows, event({ orderSeq: 1, eventType: 'translation.final', text: 'First', targetLanguage: 'en-US' }));
    expect(rows.map((row) => row.orderSeq)).toEqual([1, 2]);
    expect(rows[0]?.translations['en-US']).toEqual({ text: 'First', isFinal: true });
  });
});

describe('awaitsFinal', () => {
  it('is true until the transcript and every translation are final', () => {
    let rows = applyResultEvent([], event({ text: '안녕' }));
    expect(awaitsFinal(rows[0]!)).toBe(true);

    rows = applyResultEvent(rows, event({ eventType: 'transcript.final', text: '안녕하세요.' }));
    expect(awaitsFinal(rows[0]!)).toBe(true);

    const translation = { text: 'Hello.', targetLanguage: 'en-US' };
    rows = applyResultEvent(rows, event({ ...translation, eventType: 'translation.preview' }));
    expect(awaitsFinal(rows[0]!)).toBe(true);

    rows = applyResultEvent(rows, event({ ...translation, eventType: 'translation.final' }));
    expect(awaitsFinal(rows[0]!)).toBe(false);
  });
});
