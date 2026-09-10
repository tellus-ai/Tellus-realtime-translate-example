import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MicrophoneRecorder } from '../src/audio/BrowserMicrophone';
import type { PcmFrame } from '../src/audio/PcmFramePipeline';
import type { RealtimeAudioEncoder } from '../src/audio/opus/OpusEncoderWorkerClient';
import type { ClientVadProcessor, VadDecision, VadProcessInput } from '../src/audio/vad/VADTypes';
import { RealtimeTranslationSession } from '../src/realtime/RealtimeTranslationSession';

class FakeMicrophone implements MicrophoneRecorder {
  private onFrame: ((frame: PcmFrame) => void) | null = null;

  async start(onFrame: (frame: PcmFrame) => void): Promise<void> {
    this.onFrame = onFrame;
  }

  async pause(): Promise<void> {}
  async resume(): Promise<void> {}
  async stop(): Promise<void> { this.onFrame = null; }

  emit(frame: PcmFrame): void {
    this.onFrame?.(frame);
  }
}

class DeferredVad implements ClientVadProcessor {
  readonly calls: VadProcessInput[] = [];
  private resolvers: Array<(decision: VadDecision) => void> = [];

  async initialize(): Promise<void> {}
  async reset(): Promise<void> {}
  async dispose(): Promise<void> {}

  process(input: VadProcessInput): Promise<VadDecision> {
    this.calls.push(input);
    return new Promise((resolve) => this.resolvers.push(resolve));
  }

  resolveNext(decision: VadDecision): void {
    const resolve = this.resolvers.shift();
    if (!resolve) throw new Error('No pending VAD request');
    resolve(decision);
  }
}

class FakeAudioEncoder implements RealtimeAudioEncoder {
  readonly inputs: ArrayBuffer[] = [];
  initialized = false;
  disposed = false;
  resetCount = 0;

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  async encode(pcm16: ArrayBuffer): Promise<ArrayBuffer> {
    this.inputs.push(pcm16);
    return new Uint8Array([this.inputs.length, 2, 3]).buffer;
  }

  async reset(): Promise<void> {
    this.resetCount += 1;
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readonly messages: Array<string | ArrayBuffer> = [];
  readyState = FakeWebSocket.CONNECTING;
  binaryType = 'blob';
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.(new Event('open'));
    });
  }

  send(data: string | ArrayBuffer): void {
    this.messages.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }
}

const endpoints = { httpBaseUrl: 'https://example.test', websocketBaseUrl: 'wss://example.test' };

describe('RealtimeTranslationSession audio pipeline', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    FakeWebSocket.instances = [];
    let requestIndex = 0;
    fetchMock = vi.fn(async () => {
      const body = requestIndex === 0 ? { conversation_id: 'conversation-1' } : {};
      requestIndex += 1;
      return new Response(JSON.stringify(body), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.stubGlobal('window', { setTimeout, clearTimeout, location: new URL('https://app.test/') });
  });

  afterEach(() => vi.unstubAllGlobals());

  it('serializes VAD, transition status, and every PCM frame in FIFO order', async () => {
    const microphone = new FakeMicrophone();
    const vad = new DeferredVad();
    const session = new RealtimeTranslationSession(endpoints, microphone, 'token', () => vad);
    await session.start({ sourceLanguage: 'ko-KR', targetLanguage: 'en-US', clientVad: true });

    const frame = (): PcmFrame => ({ samples: new Float32Array(320), pcm16: new ArrayBuffer(640) });
    microphone.emit(frame());
    microphone.emit(frame());
    await flushPromises();
    expect(vad.calls.map((call) => call.sampleStart)).toEqual([0]);

    vad.resolveNext(decision('open', 'speech_gate_opened', 0.9));
    await flushPromises();
    expect(vad.calls.map((call) => call.sampleStart)).toEqual([0, 320]);
    vad.resolveNext(decision('closed', 'speech_gate_closed', 0.1));
    await flushPromises();

    const audioMessages = FakeWebSocket.instances[1]?.messages ?? [];
    expect(readStatus(audioMessages[0]).status_seq).toBe(1);
    expect(readStatus(audioMessages[1])).toMatchObject({
      status_seq: 2,
      boundary_sample: 0,
      vad: { event: 'speech_gate_opened' },
    });
    expect(audioMessages[2]).toBeInstanceOf(ArrayBuffer);
    expect(readStatus(audioMessages[3])).toMatchObject({
      status_seq: 3,
      boundary_sample: 320,
      vad: { event: 'speech_gate_closed' },
    });
    expect(audioMessages[4]).toBeInstanceOf(ArrayBuffer);

    const settings = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(settings.transcription.client_vad).toBe(true);
    expect(settings.translation).toEqual({});
    await session.stop();
  });

  it('does not construct a model worker when client VAD is disabled', async () => {
    const microphone = new FakeMicrophone();
    const factory = vi.fn(() => new DeferredVad());
    const session = new RealtimeTranslationSession(endpoints, microphone, 'token', factory);
    await session.start({ sourceLanguage: 'ko-KR', targetLanguage: 'en-US', clientVad: false });
    microphone.emit({ samples: new Float32Array(320), pcm16: new ArrayBuffer(640) });
    await flushPromises();

    expect(factory).not.toHaveBeenCalled();
    const settings = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body));
    expect(settings.transcription.client_vad).toBe(false);
    expect(settings.translation).toEqual({});
    expect(FakeWebSocket.instances[1]?.url).toContain('audio_format=pcm16');
    expect(FakeWebSocket.instances[1]?.messages[1]).toBeInstanceOf(ArrayBuffer);
    await session.stop();
  });

  it('encodes frames as Opus and keeps the sample cursor independent of payload size', async () => {
    const microphone = new FakeMicrophone();
    const encoder = new FakeAudioEncoder();
    const session = new RealtimeTranslationSession(
      endpoints,
      microphone,
      'token',
      () => new DeferredVad(),
      {
        resolveFormat: () => 'opus',
        createOpusEncoder: () => encoder,
      },
    );
    await session.start({ sourceLanguage: 'ko-KR', targetLanguage: 'en-US', clientVad: false });

    microphone.emit({ samples: new Float32Array(320), pcm16: new ArrayBuffer(640) });
    microphone.emit({ samples: new Float32Array(320), pcm16: new ArrayBuffer(640) });
    await flushPromises();

    const audioSocket = FakeWebSocket.instances[1];
    expect(encoder.initialized).toBe(true);
    expect(encoder.inputs).toHaveLength(2);
    expect(audioSocket?.url).toContain('audio_format=opus');
    expect(Array.from(new Uint8Array(audioSocket?.messages[1] as ArrayBuffer))).toEqual([1, 2, 3]);
    expect(Array.from(new Uint8Array(audioSocket?.messages[2] as ArrayBuffer))).toEqual([2, 2, 3]);
    expect(session.getSnapshot().phase).toBe('recording');

    await session.stop();
    expect(encoder.disposed).toBe(true);
  });

  it('aborts instead of dropping PCM when the FIFO exceeds 200ms', async () => {
    const microphone = new FakeMicrophone();
    const vad = new DeferredVad();
    const session = new RealtimeTranslationSession(endpoints, microphone, 'token', () => vad);
    await session.start({ sourceLanguage: 'ko-KR', targetLanguage: 'en-US', clientVad: true });
    for (let index = 0; index < 11; index += 1) {
      microphone.emit({ samples: new Float32Array(320), pcm16: new ArrayBuffer(640) });
    }
    await flushPromises();

    expect(session.getSnapshot()).toMatchObject({
      phase: 'error',
      error: 'Audio processing latency exceeded 200 ms. The session was stopped safely.',
    });
  });

  it('sends a capturing close event before the paused lifecycle status', async () => {
    const microphone = new FakeMicrophone();
    const vad = new DeferredVad();
    const session = new RealtimeTranslationSession(endpoints, microphone, 'token', () => vad);
    await session.start({ sourceLanguage: 'ko-KR', targetLanguage: 'en-US', clientVad: true });
    microphone.emit({ samples: new Float32Array(320), pcm16: new ArrayBuffer(640) });
    await flushPromises();
    vad.resolveNext(decision('open', 'speech_gate_opened', 0.9));
    await flushPromises();
    await session.pause();

    const messages = FakeWebSocket.instances[1]?.messages ?? [];
    expect(readStatus(messages[3])).toMatchObject({
      boundary_sample: 320,
      mic: { state: 'capturing' },
      vad: { enabled: true, event: 'speech_gate_closed' },
    });
    expect(readStatus(messages[4])).toMatchObject({
      boundary_sample: 320,
      mic: { state: 'paused' },
      vad: { enabled: true },
    });
    expect(readStatus(messages[4]).vad).not.toHaveProperty('event');
    await session.stop();
  });
});

function decision(
  gate: 'open' | 'closed',
  event: 'speech_gate_opened' | 'speech_gate_closed',
  probability: number,
): VadDecision {
  return {
    enabled: true,
    ready: true,
    mode: 'silero',
    gate,
    isSpeech: gate === 'open',
    probability,
    level: gate === 'open' ? 'veryStrong' : 'off',
    event,
    lastSpeechSampleEnd: gate === 'open' ? 320 : 320,
  };
}

function readStatus(value: string | ArrayBuffer | undefined): Record<string, any> {
  if (typeof value !== 'string') throw new Error('Expected JSON status');
  return JSON.parse(value) as Record<string, any>;
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}
