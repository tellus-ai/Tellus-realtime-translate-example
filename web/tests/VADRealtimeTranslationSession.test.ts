import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AudioChunk } from '@tellus-ai/audio-sdk-web';
import type { MicrophoneRecorder } from '../src/audio/BrowserMicrophone';
import { RealtimeTranslationSession } from '../src/realtime/RealtimeTranslationSession';

class FakeMicrophone implements MicrophoneRecorder {
  audioSdkReady = true;
  preparedVad?: boolean;
  authorization: Promise<void> = Promise.resolve();
  started = false;
  tail?: AudioChunk;
  private onFrame?: (frame: AudioChunk) => void;
  private onError?: (error: Error) => void;

  async prepare(clientVad: boolean): Promise<void> { this.preparedVad = clientVad; }
  async authorize(): Promise<void> { await this.authorization; }
  releaseAuthorization(): void { this.started = false; }
  async start(onFrame: (frame: AudioChunk) => void, onError: (error: Error) => void): Promise<void> {
    this.started = true;
    this.onFrame = onFrame;
    this.onError = onError;
  }
  async pause(): Promise<void> { this.started = false; }
  async resume(): Promise<void> { this.started = true; }
  async stop(): Promise<void> {
    if (this.tail) this.onFrame?.(this.tail);
    this.tail = undefined;
    this.started = false;
    this.onFrame = undefined;
  }
  emit(chunk: AudioChunk): void { this.onFrame?.(chunk); }
  fail(error: Error): void { this.onError?.(error); }
}

class FakeSocket {
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  static instances: FakeSocket[] = [];
  readonly messages: (string | ArrayBuffer)[] = [];
  readyState = 0;
  binaryType = 'blob';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.onopen?.();
      if (url.endsWith('/results')) this.onmessage?.({ data: JSON.stringify({ type: 'participants.snapshot', data: {} }) });
    });
  }
  send(data: string | ArrayBuffer): void { this.messages.push(data); }
  close(): void { this.readyState = 3; }
}

function chunk(payload: number[], gateEvent?: string, validSampleCount = 320): AudioChunk {
  return {
    data: { microphone: Uint8Array.from(payload) }, trackSource: 'microphone', codec: 'opus',
    sampleRate: 16000, sample: 77, sampleCount: 320, validSampleCount,
    durationMs: 20, timestamp: 1234, rms: 0.1, gateEvent,
  };
}

const endpoints = { httpBaseUrl: 'https://example.test', websocketBaseUrl: 'wss://example.test' };
const input = { sourceLanguage: 'ko-KR', targetLanguage: 'en-US', clientVad: true };
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const status = (value: string | ArrayBuffer) => JSON.parse(value as string);

beforeEach(() => {
  FakeSocket.instances = [];
  vi.stubGlobal('WebSocket', FakeSocket);
  vi.stubGlobal('window', { setTimeout, clearTimeout, addEventListener() {}, removeEventListener() {} });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url.endsWith('/end')) FakeSocket.instances[0]?.onmessage?.({ data: JSON.stringify({ type: 'conversation.ended' }) });
    return new Response(JSON.stringify(url.endsWith('/conversations') ? { conversation_id: 'conversation-1' } : {}), { status: 200 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe('SDK output transport', () => {
  it('waits for native permit and model-key readiness before starting microphone capture', async () => {
    const microphone = new FakeMicrophone();
    let approved!: () => void;
    microphone.authorization = new Promise((resolve) => { approved = resolve; });
    const session = new RealtimeTranslationSession(endpoints, microphone, 'token');
    const starting = session.start(input);
    await vi.waitFor(() => expect(FakeSocket.instances).toHaveLength(2));
    expect(microphone.started).toBe(false);
    expect(session.getSnapshot().phase).toBe('connecting');
    expect(FakeSocket.instances[1]?.messages).toEqual([]);
    approved();
    await starting;
    expect(microphone.started).toBe(true);
    expect(session.getSnapshot().phase).toBe('recording');
    await session.stop();
  });

  it('ignores gate events with client VAD disabled and flushes unchanged Opus bytes before idle', async () => {
    const microphone = new FakeMicrophone();
    const session = new RealtimeTranslationSession(endpoints, microphone, 'token');
    await session.start(input);
    microphone.emit(chunk([1, 2, 3], 'speech_gate_opened'));
    microphone.emit(chunk([9], 'speech_gate_closed'));
    const socket = FakeSocket.instances[1]!;
    expect(socket.url).toContain('audio_format=opus');
    expect(status(socket.messages[0]).vad).toEqual({ enabled: false });
    expect(Array.from(new Uint8Array(socket.messages[1] as ArrayBuffer))).toEqual([1, 2, 3]);
    expect(Array.from(new Uint8Array(socket.messages[2] as ArrayBuffer))).toEqual([9]);
    microphone.tail = chunk([5, 6], undefined, 7);
    await session.stop();
    expect(Array.from(new Uint8Array(socket.messages[3] as ArrayBuffer))).toEqual([5, 6]);
    expect(status(socket.messages[4])).toMatchObject({ boundary_sample: 960, mic: { state: 'idle' }, vad: { enabled: false } });
  });

  it('suppresses late output while paused and resumes with client VAD disabled', async () => {
    const microphone = new FakeMicrophone();
    const session = new RealtimeTranslationSession(endpoints, microphone, 'token');
    await session.start(input);
    microphone.emit(chunk([1], 'speech_gate_opened'));
    await session.pause();
    const socket = FakeSocket.instances[1]!;
    const count = socket.messages.length;
    microphone.emit(chunk([2], 'speech_gate_opened'));
    expect(socket.messages).toHaveLength(count);
    await session.resume();
    microphone.emit(chunk([3], 'speech_gate_opened'));
    expect(status(socket.messages.at(-2)!)).toMatchObject({ boundary_sample: 320, vad: { enabled: false } });
    await session.stop();
  });

  it('surfaces SDK processing failures and stops late output', async () => {
    const microphone = new FakeMicrophone();
    const session = new RealtimeTranslationSession(endpoints, microphone, 'token');
    await session.start(input);
    const socket = FakeSocket.instances[1]!;
    microphone.fail(new Error('tellus_audio_processing_failed'));
    microphone.emit(chunk([1]));
    await flush();
    expect(session.getSnapshot()).toMatchObject({ phase: 'error', error: 'tellus_audio_processing_failed' });
    expect(socket.messages.filter((message) => message instanceof ArrayBuffer)).toEqual([]);
    await session.stop();
  });

  it('overrides requested client VAD without changing the Rust Opus codec', async () => {
    const microphone = new FakeMicrophone();
    const session = new RealtimeTranslationSession(endpoints, microphone, 'token');
    await session.start(input);
    expect(microphone.preparedVad).toBe(false);
    expect(FakeSocket.instances[1]?.url).toContain('audio_format=opus');
    const settings = JSON.parse(String(vi.mocked(fetch).mock.calls[1]?.[1]?.body));
    expect(settings.transcription.client_vad).toBe(false);
    await session.stop();
  });
});
