const TARGET_SAMPLE_RATE = 16_000;
const FRAME_SAMPLES = 320;

export interface PcmFrame {
  /** VAD and PCM encoding must use the same 16 kHz samples. */
  samples: Float32Array;
  pcm16: ArrayBuffer;
}

export class PcmFramePipeline {
  private input = new Float32Array(0);
  private inputPosition = 0;
  private output = new Float32Array(0);

  push(samples: Float32Array, sourceSampleRate: number): PcmFrame[] {
    if (!Number.isFinite(sourceSampleRate) || sourceSampleRate <= 0 || samples.length === 0) {
      return [];
    }
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
      // Preserve fractional/overshoot phase when a small AudioWorklet chunk ends.
      // Subtracting beyond `combined.length` would restart 48k/128 input at phase 0
      // and produce 16,125 samples per second instead of 16,000.
      const consumed = Math.min(Math.floor(this.inputPosition), combined.length);
      this.input = combined.slice(consumed);
      this.inputPosition -= consumed;
    }

    const nextOutput = new Float32Array(this.output.length + resampled.length);
    nextOutput.set(this.output);
    nextOutput.set(resampled, this.output.length);
    const frames: PcmFrame[] = [];
    let offset = 0;
    while (offset + FRAME_SAMPLES <= nextOutput.length) {
      const frameSamples = nextOutput.slice(offset, offset + FRAME_SAMPLES);
      frames.push({ samples: frameSamples, pcm16: toPcm16(frameSamples) });
      offset += FRAME_SAMPLES;
    }
    this.output = nextOutput.slice(offset);
    return frames;
  }

  reset(): void {
    this.input = new Float32Array(0);
    this.output = new Float32Array(0);
    this.inputPosition = 0;
  }
}

export function toPcm16(samples: Float32Array): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * 2);
  const view = new DataView(buffer);
  samples.forEach((value, index) => {
    const clamped = Math.max(-1, Math.min(1, value));
    const pcm = clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
    view.setInt16(index * 2, pcm, true);
  });
  return buffer;
}
