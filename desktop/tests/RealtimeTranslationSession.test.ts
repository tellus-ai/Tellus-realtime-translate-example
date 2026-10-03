import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RealtimeApi } from '../electron/realtimeApi';
import {
  RealtimeTranslationSession,
  type CaptureVadStatus,
  type CapturedAudioChunk,
  type MicrophoneCapture,
} from '../electron/realtime/RealtimeTranslationSession';
import type { StartConversationInput } from '../electron/shared/desktopApi';

class FakeCapture implements MicrophoneCapture {
  vadEnabled: boolean | null = null;
  paused = false;
  stopped = false;
  status: CaptureVadStatus = { vadReady: true, vadGateState: 'closed', vadProbability: 0, vadIsSpeech: false };
  private chunkCallback: ((error: Error | null, chunk: CapturedAudioChunk) => unknown) | null = null;
  private errorCallback: ((error: Error | null, detail: { message: string; recoverable: boolean }) => unknown) | null = null;
  private nextPayload = 1;

  onError(callback: (error: Error | null, detail: { message: string; recoverable: boolean }) => unknown): void {
    this.errorCallback = callback;
  }

  start(callback: (error: Error | null, chunk: CapturedAudioChunk) => unknown): void {
    this.chunkCallback = callback;
  }

  pause(): void { this.paused = true; }
  resume(): void { this.paused = false; }
  stop(): void { this.stopped = true; }
  setVadEnabled(enabled: boolean): void { this.vadEnabled = enabled; }
  getStatus(): CaptureVadStatus { return this.status; }

  emit(gateEvent?: 'speech_gate_opened' | 'speech_gate_closed'): void {
    if (gateEvent) {
      const open = gateEvent === 'speech_gate_opened';
      this.status = { vadReady: true, vadGateState: open ? 'open' : 'closed', vadProbability: open ? 0.9 : 0.1, vadIsSpeech: open };
    }
    this.chunkCallback?.(null, {
      data: { microphone: new Uint8Array([this.nextPayload++]) },
      sampleCount: 320,
      ...(gateEvent ? { gateEvent } : {}),
    });
  }

  fail(message: string): void {
    this.errorCallback?.(null, { message, recoverable: false });
  }
}

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  static holdOpen = new Set<number>();

  readonly messages: Array<string | Uint8Array> = [];
  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(readonly url: string) {
    const index = FakeWebSocket.instances.push(this) - 1;
    if (!FakeWebSocket.holdOpen.has(index)) queueMicrotask(() => this.open());
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  send(data: string | Uint8Array): void {
    this.messages.push(data);
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  serverClose(code: number, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason } as CloseEvent);
  }
}

class FakeApi implements RealtimeApi {
  readonly settings: StartConversationInput[] = [];
  readonly ended: string[] = [];

  async createConversation(): Promise<string> {
    return 'conversation-1';
  }

  async saveInterpretationSettings(_conversationId: string, input: StartConversationInput): Promise<void> {
    this.settings.push(input);
  }

  async endConversation(conversationId: string): Promise<void> {
    this.ended.push(conversationId);
  }
}

const input = { sourceLanguage: 'ko-KR', targetLanguage: 'en-US', clientVad: true };

function setup() {
  const api = new FakeApi();
  const capture = new FakeCapture();
  const session = new RealtimeTranslationSession(
    { websocketBaseUrl: 'wss://example.test' },
    api,
    async () => capture,
    (url) => new FakeWebSocket(url) as unknown as WebSocket,
  );
  return { api, capture, session };
}

describe('RealtimeTranslationSession with the audio engine', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    FakeWebSocket.holdOpen = new Set();
    vi.stubGlobal('WebSocket', FakeWebSocket);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('sends each gate transition before the frame it applies to, counting samples from the socket start', async () => {
    const { api, capture, session } = setup();
    await session.start(input);

    capture.emit();
    capture.emit('speech_gate_opened');
    capture.emit();
    capture.emit('speech_gate_closed');

    const audioSocket = FakeWebSocket.instances[1];
    expect(audioSocket?.url).toBe('wss://example.test/audio?conversation_id=conversation-1&audio_format=opus');
    expect(capture.vadEnabled).toBe(true);
    expect(api.settings).toEqual([input]);
    const messages = audioSocket?.messages ?? [];
    expect(readStatus(messages[0])).toMatchObject({ status_seq: 1, boundary_sample: 0, mic: { state: 'capturing' } });
    expect(messages[1]).toEqual(new Uint8Array([1]));
    expect(readStatus(messages[2])).toMatchObject({ status_seq: 2, boundary_sample: 320, vad: { event: 'speech_gate_opened' } });
    expect(messages[3]).toEqual(new Uint8Array([2]));
    expect(messages[4]).toEqual(new Uint8Array([3]));
    expect(readStatus(messages[5])).toMatchObject({ status_seq: 3, boundary_sample: 960, vad: { event: 'speech_gate_closed' } });
    expect(messages[6]).toEqual(new Uint8Array([4]));
    expect(session.getSnapshot().vad).toMatchObject({ enabled: true, ready: true, gate: 'closed' });

    await session.stop();
    expect(api.ended).toEqual(['conversation-1']);
    expect(capture.stopped).toBe(true);
    expect(readStatus(messages.at(-1))).toMatchObject({ mic: { state: 'idle' } });
    expect(session.getSnapshot().phase).toBe('ended');
  });

  it('turns the engine gate off for server VAD', async () => {
    const { capture, session } = setup();
    await session.start({ ...input, clientVad: false });
    capture.emit();

    const messages = FakeWebSocket.instances[1]?.messages ?? [];
    expect(capture.vadEnabled).toBe(false);
    expect(readStatus(messages[0])).toMatchObject({ vad: { enabled: false } });
    expect(messages[1]).toEqual(new Uint8Array([1]));
    expect(session.getSnapshot().vad.mode).toBe('disabled');
    await session.stop();
  });

  it('closes an open boundary before pausing and re-opens it when speech continues after resume', async () => {
    const { capture, session } = setup();
    await session.start(input);
    capture.emit('speech_gate_opened');
    await session.pause();

    const messages = FakeWebSocket.instances[1]?.messages ?? [];
    expect(capture.paused).toBe(true);
    expect(readStatus(messages[3])).toMatchObject({ boundary_sample: 320, mic: { state: 'capturing' }, vad: { event: 'speech_gate_closed' } });
    expect(readStatus(messages[4])).toMatchObject({ boundary_sample: 320, mic: { state: 'paused' } });
    expect(readStatus(messages[4]).vad).not.toHaveProperty('event');

    await session.resume();
    capture.emit();
    expect(capture.paused).toBe(false);
    expect(readStatus(messages[5])).toMatchObject({ mic: { state: 'capturing' } });
    expect(readStatus(messages[6])).toMatchObject({ boundary_sample: 320, vad: { event: 'speech_gate_opened' } });
    expect(messages[7]).toEqual(new Uint8Array([2]));
    await session.stop();
  });

  it('reconnects with a fresh sample cursor while status_seq keeps increasing', async () => {
    vi.useFakeTimers();
    const { capture, session } = setup();
    await session.start(input);
    capture.emit('speech_gate_opened');
    FakeWebSocket.instances[1]?.serverClose(1006);

    expect(session.getSnapshot().phase).toBe('reconnecting');
    expect(capture.paused).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.getSnapshot().phase).toBe('recording');
    expect(capture.paused).toBe(false);

    capture.emit();
    const messages = FakeWebSocket.instances[3]?.messages ?? [];
    expect(readStatus(messages[0])).toMatchObject({ status_seq: 3, boundary_sample: 0, mic: { state: 'capturing' } });
    expect(readStatus(messages[1])).toMatchObject({ status_seq: 4, boundary_sample: 0, vad: { event: 'speech_gate_opened' } });
    expect(messages[2]).toEqual(new Uint8Array([2]));
    await session.stop();
  });

  it('fails the start when the server closes the Result WebSocket during connection', async () => {
    FakeWebSocket.holdOpen.add(1);
    const { api, capture, session } = setup();
    const starting = session.start(input);
    await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));

    FakeWebSocket.instances[0]?.onmessage?.({ data: JSON.stringify({ type: 'system.error', message: ['Permission denied.'] }) } as MessageEvent);
    FakeWebSocket.instances[0]?.serverClose(1008);
    FakeWebSocket.instances[1]?.open();
    await starting;
    await vi.waitFor(() => expect(session.getSnapshot().phase).toBe('error'));

    expect(session.getSnapshot().error).toBe('Permission denied.');
    expect(api.ended).toEqual(['conversation-1']);
    expect(capture.stopped).toBe(true);
  });

  it('ends the conversation when the engine reports a fatal capture error', async () => {
    const { api, capture, session } = setup();
    await session.start(input);
    capture.fail('device lost');
    await vi.waitFor(() => expect(session.getSnapshot().phase).toBe('error'));

    expect(session.getSnapshot().error).toBe('Audio capture failed: device lost');
    expect(api.ended).toEqual(['conversation-1']);
  });

  it('rejects identical languages without creating a conversation', async () => {
    const { api, session } = setup();
    await session.start({ ...input, targetLanguage: 'ko-KR' });

    expect(session.getSnapshot()).toMatchObject({ phase: 'idle', error: 'Select two different languages.' });
    expect(api.settings).toEqual([]);
  });
});

function readStatus(value: string | Uint8Array | undefined): Record<string, any> {
  if (typeof value !== 'string') throw new Error('Expected JSON status');
  return JSON.parse(value) as Record<string, any>;
}
