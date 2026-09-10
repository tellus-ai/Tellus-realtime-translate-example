export interface WorkerOpusEncoderConfig {
  bitrateBps: number;
  frameDurationMs: number;
  onEncodedData: (data: ArrayBuffer) => void;
  onError: (error: Error) => void;
  sampleRate: number;
}

interface WorkerWebCodecsGlobal {
  AudioData?: typeof AudioData;
  AudioEncoder?: typeof AudioEncoder;
}

export class WorkerOpusEncoder {
  private encoder: AudioEncoder | null = null;
  private timestampUs = 0;

  constructor(private readonly config: WorkerOpusEncoderConfig) {}

  static isSupported(): boolean {
    const webCodecs = globalThis as unknown as WorkerWebCodecsGlobal;
    return Boolean(webCodecs.AudioEncoder && webCodecs.AudioData);
  }

  initialize(): void {
    const webCodecs = globalThis as unknown as WorkerWebCodecsGlobal;
    const AudioEncoderConstructor = webCodecs.AudioEncoder;

    if (!AudioEncoderConstructor || !webCodecs.AudioData) {
      throw new Error('[AudioWorker] WebCodecs AudioEncoder is not supported.');
    }

    this.encoder = new AudioEncoderConstructor({
      error: (error) => this.config.onError(toError(error)),
      output: (chunk) => {
        const output = new ArrayBuffer(chunk.byteLength);
        chunk.copyTo(output);
        this.config.onEncodedData(output);
      },
    });
    this.encoder.configure({
      bitrate: this.config.bitrateBps,
      codec: 'opus',
      numberOfChannels: 1,
      sampleRate: this.config.sampleRate,
    });
  }

  encode(frame: Int16Array): void {
    const encoder = this.encoder;
    const AudioDataConstructor = (globalThis as unknown as WorkerWebCodecsGlobal).AudioData;

    if (!encoder || !AudioDataConstructor) {
      throw new Error('[AudioWorker] Opus encoder is not initialized.');
    }

    const bytes = new Uint8Array(frame.byteLength);
    bytes.set(new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength));
    const audioData = new AudioDataConstructor({
      data: bytes,
      format: 's16',
      numberOfChannels: 1,
      numberOfFrames: frame.length,
      sampleRate: this.config.sampleRate,
      timestamp: this.timestampUs,
    });

    encoder.encode(audioData);
    audioData.close();
    this.timestampUs += this.config.frameDurationMs * 1_000;
  }

  close(): void {
    if (this.encoder?.state !== 'closed') this.encoder?.close();
    this.encoder = null;
    this.timestampUs = 0;
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
