const TARGET_SAMPLE_RATE = 16_000;
const FRAME_SAMPLES = 320;

export interface PcmAudioFrame {
  /** The exact normalized samples used to produce pcm16. */
  samples: Float32Array;
  pcm16: ArrayBuffer;
  sampleCount: number;
}

export class PcmFramePipeline {
  private input = new Float32Array(0);
  private inputPosition = 0;
  private output = new Float32Array(0);

  push(samples: Float32Array, sourceSampleRate: number): PcmAudioFrame[] {
    if (!Number.isFinite(sourceSampleRate) || sourceSampleRate <= 0 || samples.length === 0) return [];
    const ratio = sourceSampleRate / TARGET_SAMPLE_RATE;
    const resampled: number[] = [];
    if (sourceSampleRate === TARGET_SAMPLE_RATE) {
      resampled.push(...samples);
      this.input = new Float32Array(0);
      this.inputPosition = 0;
    } else {
      const combined = new Float32Array(this.input.length + samples.length);
      combined.set(this.input);
      combined.set(samples, this.input.length);
      while (this.inputPosition + 1 < combined.length) {
        const index = Math.floor(this.inputPosition);
        const fraction = this.inputPosition - index;
        const left = combined[index] ?? 0;
        const right = combined[index + 1] ?? left;
        resampled.push(left + (right - left) * fraction);
        this.inputPosition += ratio;
      }
      // Preserve the last interpolation sample and fractional phase across callback chunks.
      const consumed = Math.min(Math.floor(this.inputPosition), Math.max(0, combined.length - 1));
      this.input = combined.slice(consumed);
      this.inputPosition -= consumed;
    }
    const nextOutput = new Float32Array(this.output.length + resampled.length);
    nextOutput.set(this.output);
    nextOutput.set(resampled, this.output.length);
    const frames: PcmAudioFrame[] = [];
    let offset = 0;
    while (offset + FRAME_SAMPLES <= nextOutput.length) {
      const normalizedSamples = nextOutput.slice(offset, offset + FRAME_SAMPLES);
      frames.push({
        samples: normalizedSamples,
        pcm16: toPcm16(normalizedSamples),
        sampleCount: normalizedSamples.length,
      });
      offset += FRAME_SAMPLES;
    }
    this.output = nextOutput.slice(offset);
    return frames;
  }

  reset(): void {
    this.input = new Float32Array(0);
    this.inputPosition = 0;
    this.output = new Float32Array(0);
  }
}

export function toPcm16(samples: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  samples.forEach((value, index) => {
    const clamped = Math.max(-1, Math.min(1, value));
    view.setInt16(index * 2, clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff), true);
  });
  return buffer;
}
