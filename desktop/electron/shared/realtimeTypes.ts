// Session state produced in the main process and rendered by the renderer.

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

export type VadGate = 'open' | 'closed';
export type VadLevel = 'off' | 'weak' | 'medium' | 'strong' | 'veryStrong';
export type VadEvent = 'speech_gate_opened' | 'speech_gate_closed';

export interface ClientVadSnapshot {
  enabled: boolean;
  ready: boolean;
  mode: 'silero' | 'disabled';
  gate: VadGate;
  isSpeech: boolean;
  probability: number;
  level: VadLevel;
}

export interface SessionSnapshot {
  phase: SessionPhase;
  conversationId: string | null;
  resultConnection: ConnectionStatus;
  audioConnection: ConnectionStatus;
  rows: TranslationRow[];
  vad: ClientVadSnapshot;
  error: string | null;
}
