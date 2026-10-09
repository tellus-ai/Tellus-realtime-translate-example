export interface VadSnapshot {
  enabled: boolean;
  ready: boolean;
  mode: 'silero' | 'disabled';
  gate: 'open' | 'closed';
}
