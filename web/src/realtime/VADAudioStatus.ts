import type { ClientVadSnapshot, VadEvent } from '../audio/vad/VADTypes';

export type MicrophoneState = 'capturing' | 'paused' | 'idle';

export function disabledVadSnapshot(ready = true): ClientVadSnapshot {
  return {
    enabled: false,
    ready,
    mode: 'disabled',
    gate: 'open',
  };
}

export function sileroVadSnapshot(ready = false): ClientVadSnapshot {
  return {
    enabled: true,
    ready,
    mode: 'silero',
    gate: 'closed',
  };
}

export function buildAudioStatusMessage(input: {
  statusSequence: number;
  sample: number;
  microphoneState: MicrophoneState;
  vad: ClientVadSnapshot;
  event?: VadEvent;
}) {
  return {
    type: 'audio.status' as const,
    version: 1 as const,
    status_seq: Math.max(0, Math.floor(input.statusSequence)),
    boundary_sample: Math.max(0, Math.floor(input.sample)),
    mic: { state: input.microphoneState },
    vad: {
      enabled: input.vad.enabled,
      ...(input.event ? { event: input.event } : {}),
    },
  };
}
