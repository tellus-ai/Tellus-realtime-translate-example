import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorkerOpusEncoder } from '../src/audio/opus/WorkerOpusEncoder';

class FakeAudioData {
  static instances: FakeAudioData[] = [];
  closed = false;

  constructor(readonly init: AudioDataInit) {
    FakeAudioData.instances.push(this);
  }

  get timestamp(): number {
    return this.init.timestamp;
  }

  close(): void {
    this.closed = true;
  }
}

class FakeAudioEncoder {
  static instances: FakeAudioEncoder[] = [];
  state: CodecState = 'unconfigured';
  configuredWith: AudioEncoderConfig | null = null;

  constructor(private readonly init: AudioEncoderInit) {
    FakeAudioEncoder.instances.push(this);
  }

  configure(config: AudioEncoderConfig): void {
    this.configuredWith = config;
    this.state = 'configured';
  }

  encode(data: { timestamp: number }): void {
    const payload = new Uint8Array([data.timestamp / 20_000 + 1, 2, 3]);
    this.init.output({
      byteLength: payload.byteLength,
      copyTo: (destination: AllowSharedBufferSource) => {
        const target = ArrayBuffer.isView(destination)
          ? new Uint8Array(destination.buffer, destination.byteOffset, destination.byteLength)
          : new Uint8Array(destination);
        target.set(payload);
      },
    } as EncodedAudioChunk);
  }

  close(): void {
    this.state = 'closed';
  }
}

describe('WorkerOpusEncoder', () => {
  afterEach(() => {
    FakeAudioData.instances = [];
    FakeAudioEncoder.instances = [];
    vi.unstubAllGlobals();
  });

  it('encodes 20ms mono PCM frames as 64kbps Opus with monotonic timestamps', () => {
    vi.stubGlobal('AudioData', FakeAudioData);
    vi.stubGlobal('AudioEncoder', FakeAudioEncoder);
    const output: ArrayBuffer[] = [];
    const encoder = new WorkerOpusEncoder({
      bitrateBps: 64_000,
      frameDurationMs: 20,
      sampleRate: 16_000,
      onEncodedData: (payload) => output.push(payload),
      onError: (error) => { throw error; },
    });

    encoder.initialize();
    encoder.encode(new Int16Array(320));
    encoder.encode(new Int16Array(320));

    expect(FakeAudioEncoder.instances[0]?.configuredWith).toEqual({
      bitrate: 64_000,
      codec: 'opus',
      numberOfChannels: 1,
      sampleRate: 16_000,
    });
    expect(FakeAudioData.instances.map(({ init }) => init.timestamp)).toEqual([0, 20_000]);
    expect(FakeAudioData.instances.every(({ closed }) => closed)).toBe(true);
    expect(output.map((payload) => Array.from(new Uint8Array(payload)))).toEqual([
      [1, 2, 3],
      [2, 2, 3],
    ]);

    encoder.close();
    expect(FakeAudioEncoder.instances[0]?.state).toBe('closed');
  });
});
