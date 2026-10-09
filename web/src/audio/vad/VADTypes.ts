export type VadGate = 'open' | 'closed';
export type VadEvent = 'speech_gate_opened' | 'speech_gate_closed';

/** 엔진이 실제로 제공하는 값만 표시한다. */
export interface ClientVadSnapshot {
  enabled: boolean;
  ready: boolean;
  mode: 'silero' | 'disabled';
  gate: VadGate;
}
