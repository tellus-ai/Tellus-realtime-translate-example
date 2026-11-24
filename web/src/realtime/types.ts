import type { ClientVadSnapshot } from '../audio/vad/VADTypes';

export type ResultEventType =
  | 'transcript.preview'
  | 'transcript.final'
  | 'translation.preview'
  | 'translation.final';

/** One row update. A Result message carries one or more of them. */
export interface ResultEvent {
  conversationId: string;
  eventType: ResultEventType;
  orderSeq: number;
  text: string;
  /** Null when the server does not know the language. */
  sourceLanguage: string | null;
  targetLanguage: string | null;
}

export interface TranslationText {
  text: string;
  isFinal: boolean;
}

export interface TranslationRow {
  orderSeq: number;
  sourceLanguage: string | null;
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

export interface DenoiseSnapshot {
  enabled: boolean;
  applied: boolean | null;
  updating: boolean;
  error: string | null;
}

export interface SessionSnapshot {
  phase: SessionPhase;
  conversationId: string | null;
  resultConnection: ConnectionStatus;
  audioConnection: ConnectionStatus;
  rows: TranslationRow[];
  audioSdkReady: boolean;
  recordingAvailable: boolean;
  denoise: DenoiseSnapshot;
  vad: ClientVadSnapshot;
  error: string | null;
}
