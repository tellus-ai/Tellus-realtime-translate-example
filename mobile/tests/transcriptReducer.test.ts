import { applyResultEvent, awaitsFinal, lastCompleteOrderSeq } from '../src/realtime/transcriptReducer';
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

  it('accepts a final that is shorter than its preview: the rest moved to the next order_seq', () => {
    let rows = applyResultEvent([], event({ orderSeq: 7, text: "다음 안건으로 넘어가겠습니다 Let's check" }));
    rows = applyResultEvent(rows, event({ orderSeq: 7, eventType: 'transcript.final', text: '다음 안건으로 넘어가겠습니다' }));
    rows = applyResultEvent(rows, event({ orderSeq: 8, text: "Let's check", sourceLanguage: 'en-US' }));
    expect(rows.map((row) => [row.orderSeq, row.source?.text, row.source?.isFinal])).toEqual([
      [7, '다음 안건으로 넘어가겠습니다', true],
      [8, "Let's check", false],
    ]);
  });

  it('keeps a final when a preview of the same order_seq arrives after it', () => {
    const translation = { targetLanguage: 'en-US' };
    let rows = applyResultEvent([], event({ eventType: 'transcript.final', text: '안녕하세요.' }));
    rows = applyResultEvent(rows, event({ ...translation, eventType: 'translation.final', text: 'Hello.' }));
    rows = applyResultEvent(rows, event({ text: '안녕' }));
    rows = applyResultEvent(rows, event({ ...translation, eventType: 'translation.preview', text: 'Hel' }));
    expect(rows[0]).toMatchObject({
      source: { text: '안녕하세요.', isFinal: true },
      translations: { 'en-US': { text: 'Hello.', isFinal: true } },
    });
  });

  it('leaves the rows as they are when the server sends the same final again after a reconnect', () => {
    const final = event({ eventType: 'transcript.final', text: '안녕하세요.' });
    const rows = applyResultEvent([], final);
    expect(applyResultEvent(rows, final)).toEqual(rows);
  });
});

describe('lastCompleteOrderSeq', () => {
  const complete = (rows: ReturnType<typeof applyResultEvent>, orderSeq: number) => applyResultEvent(
    applyResultEvent(rows, event({ orderSeq, eventType: 'transcript.final' })),
    event({ orderSeq, eventType: 'translation.final', text: 'Hi', targetLanguage: 'en-US' }),
  );

  it('is null until a row has its final transcript and translation', () => {
    expect(lastCompleteOrderSeq([])).toBeNull();
    expect(lastCompleteOrderSeq(applyResultEvent([], event({ orderSeq: 0, eventType: 'transcript.final' })))).toBeNull();
  });

  it('stops before the first row that still waits, even when later rows are complete', () => {
    let rows = complete(complete([], 0), 1);
    expect(lastCompleteOrderSeq(rows)).toBe(1);
    rows = applyResultEvent(rows, event({ orderSeq: 2, eventType: 'transcript.final' }));
    rows = complete(rows, 3);
    expect(lastCompleteOrderSeq(rows)).toBe(1);
  });

  it('follows the order_seq values as they are when the server skipped a number', () => {
    expect(lastCompleteOrderSeq(complete(complete([], 0), 2))).toBe(2);
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
