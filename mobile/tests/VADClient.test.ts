import {
  CLIENT_VAD_POLICY,
  ClientVadPipeline,
  ConsecutiveVadErrorBudget,
  SampleBasedVadGate,
  calculateRms,
  resolveVadLevel,
  type VadRuntime,
} from '../src/audio/VADClient';
import type { PcmAudioFrame } from '../src/audio/PcmFramePipeline';

function frame(value = 0): PcmAudioFrame {
  const samples = new Float32Array(320).fill(value);
  return { samples, pcm16: new ArrayBuffer(640), sampleCount: 320 };
}

describe('SampleBasedVadGate', () => {
  it('uses Silero probability only and closes after the 550ms sample budget', () => {
    const gate = new SampleBasedVadGate();
    const opened = gate.process(0.6, 0, 0, 320);
    expect(opened).toMatchObject({ gate: 'open', isSpeech: true, event: 'speech_gate_opened', level: 'medium' });

    let decision = gate.process(0.1, 1, 320, 320);
    expect(decision).toMatchObject({ gate: 'open', isSpeech: true, level: 'weak' });
    for (let sample = 640; sample <= 8_640; sample += 320) {
      decision = gate.process(0.1, 1, sample, 320);
    }
    expect(decision.gate).toBe('open');

    decision = gate.process(0.1, 1, 8_960, 320);
    expect(decision).toMatchObject({ gate: 'closed', isSpeech: false, event: 'speech_gate_closed', level: 'off' });
  });

  it('holds the speech decision between the 0.5 and 0.35 thresholds', () => {
    const gate = new SampleBasedVadGate();
    gate.process(0.8, 0, 0, 320);
    expect(gate.process(0.4, 0, 320, 320).isSpeech).toBe(true);
    expect(new SampleBasedVadGate().process(0.4, 1, 0, 320).gate).toBe('closed');
  });
});

describe('ClientVadPipeline', () => {
  it('serializes inference and emits every silent PCM frame in cursor order', async () => {
    let active = 0;
    let maxActive = 0;
    const runtime: VadRuntime = {
      initialize: async () => {},
      reset: () => {},
      dispose: async () => {},
      process: async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active -= 1;
        return 0;
      },
    };
    const samples: number[] = [];
    const pipeline = new ClientVadPipeline(runtime, {
      onDecision: () => {},
      onFatal: (error) => { throw error; },
      onOutput: (_frame, _decision, sampleStart) => samples.push(sampleStart),
    });
    pipeline.enqueue(frame());
    pipeline.enqueue(frame());
    pipeline.enqueue(frame());
    await pipeline.drain();

    expect(maxActive).toBe(1);
    expect(samples).toEqual([0, 320, 640]);
  });

  it('invalidates an enqueued frame on stream reset', async () => {
    const runtime: VadRuntime = {
      initialize: async () => {},
      reset: () => {},
      dispose: async () => {},
      process: async () => 0.8,
    };
    const outputs: number[] = [];
    const pipeline = new ClientVadPipeline(runtime, {
      onDecision: () => {},
      onFatal: (error) => { throw error; },
      onOutput: (_frame, _decision, sampleStart) => outputs.push(sampleStart),
    });
    pipeline.enqueue(frame());
    pipeline.reset(0);
    await pipeline.drain();
    expect(outputs).toEqual([]);
  });
});

describe('VAD policy helpers', () => {
  it('aborts on the eighth consecutive inference failure and resets after success', () => {
    const budget = new ConsecutiveVadErrorBudget();
    for (let index = 0; index < CLIENT_VAD_POLICY.maxConsecutiveErrors - 1; index += 1) {
      expect(() => budget.failure(new Error('native failure'))).not.toThrow();
    }
    expect(() => budget.failure(new Error('native failure'))).toThrow('8 consecutive times');
    budget.reset();
    expect(() => budget.failure(new Error('native failure'))).not.toThrow();
    budget.success();
    expect(() => budget.failure(new Error('native failure'))).not.toThrow();
  });

  it('keeps RMS observational and follows desktop level thresholds', () => {
    expect(calculateRms(new Float32Array([1, -1]))).toBe(1);
    expect(resolveVadLevel(0.9, true)).toBe('veryStrong');
    expect(resolveVadLevel(0.7, true)).toBe('strong');
    expect(resolveVadLevel(0.55, true)).toBe('medium');
    expect(resolveVadLevel(0.1, true)).toBe('weak');
    expect(resolveVadLevel(1, false)).toBe('off');
  });
});
