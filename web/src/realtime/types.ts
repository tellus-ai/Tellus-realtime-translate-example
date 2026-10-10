import type { ClientVadSnapshot } from '../audio/vad/VADTypes';

export type ResultEventType =
  | 'transcript.preview'
  | 'transcript.final'
  | 'translation.preview'
  | 'translation.final';

export interface ResultEvent {
  conversationId: string;
  eventType: ResultEventType;
  orderSeq: number;
  text: string;
  sourceLanguage: string;
  targetLanguage: string | null;
}

export interface TranslationText {
  text: string;
  isFinal: boolean;
}

export interface TranslationRow {
  orderSeq: number;
  sourceLanguage: string;
  source: TranslationText | null;
  translations: Record<string, TranslationText>;
}

export type SessionPhase =
  | 'idle'
  | 'preparing-audio'
  | 'creating'
  | 'configuring'
  | 'connecting'
  | 'recording'
  | 'paused'
  | 'reconnecting'
  | 'stopping'
  | 'ended'
  | 'error';

export type ConnectionStatus = 'closed' | 'connecting' | 'open' | 'error';

export interface SessionSnapshot {
  phase: SessionPhase;
  conversationId: string | null;
  resultConnection: ConnectionStatus;
  audioConnection: ConnectionStatus;
  rows: TranslationRow[];
  audioSdkReady: boolean;
  vad: ClientVadSnapshot;
  error: string | null;
}
