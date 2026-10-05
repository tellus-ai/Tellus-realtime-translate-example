import { describe, expect, it } from 'vitest';
import {
  buildAudioStatusMessage,
  disabledVadSnapshot,
  resolveVadLevel,
  sileroVadSnapshot,
} from '../electron/realtime/VADAudioStatus';

describe('audio status', () => {
  it('preserves the disabled VAD wire contract', () => {
    const capturing = buildAudioStatusMessage({
      statusSequence: 1,
      sample: 0,
      microphoneState: 'capturing',
      vad: disabledVadSnapshot(),
    });
    const paused = buildAudioStatusMessage({
      statusSequence: 2,
      sample: 320,
      microphoneState: 'paused',
      vad: disabledVadSnapshot(),
    });
    expect(capturing.boundary_sample).toBe(0);
    expect(capturing.vad).toEqual({
      enabled: false,
    });
    expect(paused.boundary_sample).toBe(320);
    expect(paused.vad).toEqual({ enabled: false });
  });

  it('maps the desktop SDK level boundaries', () => {
    expect(resolveVadLevel(true, true, 0.49)).toBe('weak');
    expect(resolveVadLevel(true, true, 0.5)).toBe('medium');
    expect(resolveVadLevel(true, true, 0.65)).toBe('strong');
    expect(resolveVadLevel(true, true, 0.85)).toBe('veryStrong');
    expect(resolveVadLevel(true, false, 1)).toBe('off');
  });

  it('includes a transition event only when supplied', () => {
    const vad = { ...sileroVadSnapshot(true), gate: 'open' as const, isSpeech: true, probability: 0.9, level: 'veryStrong' as const };
    const status = buildAudioStatusMessage({
      statusSequence: 3,
      sample: 640,
      microphoneState: 'capturing',
      vad,
      event: 'speech_gate_opened',
    });
    expect(status.boundary_sample).toBe(640);
    expect(status.vad).toEqual({ enabled: true, event: 'speech_gate_opened' });
  });
});
