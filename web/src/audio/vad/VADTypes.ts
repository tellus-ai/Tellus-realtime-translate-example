export type VadGate = 'open' | 'closed';
export type VadLevel = 'off' | 'weak' | 'medium' | 'strong' | 'veryStrong';

export interface ClientVadSnapshot {
  enabled: boolean;
  ready: boolean;
  mode: 'silero' | 'disabled';
  gate: VadGate;
  isSpeech: boolean;
  probability: number;
  level: VadLevel;
}

export type VadEvent = 'speech_gate_opened' | 'speech_gate_closed';

export interface VadDecision extends ClientVadSnapshot {
  event?: VadEvent;
  /** Used only for internal gate diagnostics, not for wire samples. */
  lastSpeechSampleEnd: number | null;
}

export interface VadProcessInput {
  samples: Float32Array;
  sampleStart: number;
}

export interface ClientVadProcessor {
  initialize(): Promise<void>;
  reset(): Promise<void>;
  process(input: VadProcessInput): Promise<VadDecision>;
  dispose(): Promise<void>;
}

export type VadWorkerRequestBody =
  | { type: 'initialize'; modelUrl: string; wasmBaseUrl: string }
  | { type: 'reset' }
  | { type: 'process'; sampleStart: number; samples: ArrayBuffer }
  | { type: 'dispose' };

export type VadWorkerRequest = VadWorkerRequestBody & { id: number; generation: number };

export type VadWorkerResponse =
  | { id: number; generation: number; type: 'ready' | 'reset' | 'disposed' }
  | { id: number; generation: number; type: 'decision'; decision: VadDecision }
  | { id: number; generation: number; type: 'error'; fatal: boolean; message: string };

export interface GateState {
  gate: VadGate;
  isSpeech: boolean;
  probability: number;
  lastSpeechSampleEnd: number | null;
}
