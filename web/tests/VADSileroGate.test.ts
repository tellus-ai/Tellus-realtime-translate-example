import { describe, expect, it } from 'vitest';
import { VADSileroGate } from '../src/audio/vad/VADSileroGate';

describe('VADSileroGate', () => {
  it('uses the SDK hysteresis thresholds', () => {
    const gate = new VADSileroGate();
    expect(gate.process(0.49, 0, 320).gate).toBe('closed');
    expect(gate.process(0.5, 320, 320)).toMatchObject({
      gate: 'open',
      event: 'speech_gate_opened',
      level: 'medium',
    });
    expect(gate.process(0.36, 640, 320).gate).toBe('open');
  });

  it('closes after 550ms of sample-counted silence', () => {
    const gate = new VADSileroGate();
    gate.process(0.9, 0, 320);
    for (let index = 0; index < 27; index += 1) {
      expect(gate.process(0.35, 320 + index * 320, 320).gate).toBe('open');
    }
    expect(gate.process(0.35, 8_960, 320)).toMatchObject({
      gate: 'closed',
      event: 'speech_gate_closed',
      lastSpeechSampleEnd: 320,
    });
  });
});
