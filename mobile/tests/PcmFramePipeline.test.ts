import { PcmFramePipeline, toPcm16 } from '../src/audio/PcmFramePipeline';

describe('PcmFramePipeline', () => {
  it('emits a 640-byte frame for 20ms at 16kHz', () => {
    const frames = new PcmFramePipeline().push(new Float32Array(320), 16_000);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.pcm16.byteLength).toBe(640);
    expect(frames[0]?.samples).toHaveLength(320);
    expect(frames[0]?.sampleCount).toBe(320);
  });

  it('encodes little-endian PCM16', () => {
    const view = new DataView(toPcm16(new Float32Array([-1, 1])));
    expect(view.getInt16(0, true)).toBe(-32768);
    expect(view.getInt16(2, true)).toBe(32767);
  });

  it('keeps phase across 128-sample callbacks when resampling 48kHz to exactly 16kHz', () => {
    const pipeline = new PcmFramePipeline();
    let outputSamples = 0;
    for (let callback = 0; callback < 375; callback += 1) {
      for (const frame of pipeline.push(new Float32Array(128), 48_000)) {
        outputSamples += frame.sampleCount;
      }
    }
    expect(outputSamples).toBe(16_000);
  });
});
