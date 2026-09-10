import { describe, expect, it } from 'vitest';
import { PcmFramePipeline, toPcm16 } from '../src/audio/PcmFramePipeline';

describe('PcmFramePipeline', () => {
  it('emits one 20ms PCM16 frame at 16kHz', () => {
    const pipeline = new PcmFramePipeline();
    const frames = pipeline.push(new Float32Array(320).fill(0.5), 16_000);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.samples).toEqual(new Float32Array(320).fill(0.5));
    expect(frames[0]?.pcm16.byteLength).toBe(640);
    expect(new DataView(frames[0]!.pcm16).getInt16(0, true)).toBe(16_384);

    pipeline.push(new Float32Array(320).fill(-0.5), 16_000);
    expect(frames[0]?.samples[0]).toBe(0.5);
  });

  it('writes little-endian signed samples', () => {
    const frame = toPcm16(new Float32Array([-1, 1]));
    const view = new DataView(frame);
    expect(view.getInt16(0, true)).toBe(-32768);
    expect(view.getInt16(2, true)).toBe(32767);
  });

  it('preserves resampler phase across 48kHz AudioWorklet chunks', () => {
    const pipeline = new PcmFramePipeline();
    let outputSamples = 0;
    for (let chunk = 0; chunk < 375; chunk += 1) {
      outputSamples += pipeline.push(new Float32Array(128), 48_000).length * 320;
    }
    expect(outputSamples).toBe(16_000);
  });
});
