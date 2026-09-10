import type { VadSnapshot } from '../audio/VADTypes';

export type ResultEventType = 'transcript.preview' | 'transcript.final' | 'translation.preview' | 'translation.final';

export interface ResultEvent {
  conversationId: string;
  eventType: ResultEventType;
  orderSeq: number;
  text: string;
  sourceLanguage: string;
  targetLanguage: string | null;
}

export interface TranslationText { text: string; isFinal: boolean }
export interface TranslationRow {
  orderSeq: number;
  sourceLanguage: string;
  source: TranslationText | null;
  translations: Record<string, TranslationText>;
}

export type SessionPhase = 'idle' | 'creating' | 'configuring' | 'connecting' | 'recording' | 'paused' | 'reconnecting' | 'stopping' | 'ended' | 'error';
export type ConnectionStatus = 'closed' | 'connecting' | 'open' | 'error';
export interface SessionSnapshot {
  phase: SessionPhase;
  conversationId: string | null;
  resultConnection: ConnectionStatus;
  audioConnection: ConnectionStatus;
  rows: TranslationRow[];
  error: string | null;
  vad: VadSnapshot;
}
