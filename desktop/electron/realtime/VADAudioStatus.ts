import type { ClientVadSnapshot, VadEvent, VadLevel } from '../shared/realtimeTypes';

export type MicrophoneState = 'capturing' | 'paused' | 'idle';

export function resolveVadLevel(enabled: boolean, isSpeech: boolean, probability: number): VadLevel {
  if (!enabled || !isSpeech) return 'off';
  if (probability >= 0.85) return 'veryStrong';
  if (probability >= 0.65) return 'strong';
  if (probability >= 0.5) return 'medium';
  return 'weak';
}

export function disabledVadSnapshot(ready = true): ClientVadSnapshot {
  return {
    enabled: false,
    ready,
    mode: 'disabled',
    gate: 'open',
    isSpeech: false,
    probability: 0,
    level: 'off',
  };
}

export function sileroVadSnapshot(ready = false): ClientVadSnapshot {
  return {
    enabled: true,
    ready,
    mode: 'silero',
    gate: 'closed',
    isSpeech: false,
    probability: 0,
    level: 'off',
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
