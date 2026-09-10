export type VadLevel = 'off' | 'weak' | 'medium' | 'strong' | 'veryStrong';

export interface VadSnapshot {
  enabled: boolean;
  ready: boolean;
  mode: 'silero' | 'disabled';
  gate: 'open' | 'closed';
  probability: number;
  isSpeech: boolean;
  level: VadLevel;
}
