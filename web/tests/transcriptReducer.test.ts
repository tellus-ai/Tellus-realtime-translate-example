import { describe, expect, it } from 'vitest';
import { applyResultEvent } from '../src/realtime/transcriptReducer';
import type { ResultEvent } from '../src/realtime/types';

function event(overrides: Partial<ResultEvent>): ResultEvent {
  return {
    conversationId: 'c1',
    eventType: 'transcript.preview',
    orderSeq: 1,
    text: '안녕',
    sourceLanguage: 'ko-KR',
    targetLanguage: null,
    ...overrides,
  };
}

describe('applyResultEvent', () => {
  it('updates preview and replaces it with final', () => {
    let rows = applyResultEvent([], event({ text: '안녕' }));
    rows = applyResultEvent(rows, event({ text: '안녕하세요' }));
    rows = applyResultEvent(rows, event({ eventType: 'transcript.final', text: '안녕하세요.' }));
    expect(rows[0]?.source).toEqual({ text: '안녕하세요.', isFinal: true });
  });

  it('pairs translation by order sequence and sorts late results', () => {
    let rows = applyResultEvent([], event({ orderSeq: 2, eventType: 'transcript.final' }));
    rows = applyResultEvent(rows, event({ orderSeq: 1, eventType: 'transcript.final', text: '먼저' }));
    rows = applyResultEvent(rows, event({
      orderSeq: 1,
      eventType: 'translation.final',
      text: 'First',
      targetLanguage: 'en-US',
    }));
    expect(rows.map((row) => row.orderSeq)).toEqual([1, 2]);
    expect(rows[0]?.translations['en-US']).toEqual({ text: 'First', isFinal: true });
  });
});

