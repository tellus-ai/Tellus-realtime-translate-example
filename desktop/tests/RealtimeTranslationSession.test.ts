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
  started = false;
  authorized = false;
  sequence = 0;
  status: CaptureVadStatus = { vadReady: true, vadGateState: 'closed', vadProbability: 0, vadIsSpeech: false };
  private chunkCallback: ((error: Error | null, chunk: CapturedAudioChunk) => unknown) | null = null;
  private errorCallback: ((error: Error | null, detail: { message: string; recoverable: boolean }) => unknown) | null = null;
  private nextPayload = 1;

  onError(callback: (error: Error | null, detail: { message: string; recoverable: boolean }) => unknown): void {
    this.errorCallback = callback;
  }

  start(callback: (error: Error | null, chunk: CapturedAudioChunk) => unknown): void {
    if (!this.authorized) throw new Error('engine_authorization_required');
    this.started = true;
    this.stopped = false;
    this.paused = false;
    this.chunkCallback = callback;
  }

  createAuthorizationRequest() { return { nativeInstanceId: 'instance', nonce: `nonce-${++this.sequence}`, sequence: this.sequence }; }
  applyAuthorization(token: string) {
    if (token !== `permit-${this.sequence}`) throw new Error('engine_authorization_invalid');
    this.authorized = true;
    return this.getAuthorizationStatus();
  }
  getAuthorizationStatus() {
    return { state: this.authorized ? 'authorized' as const : 'unapproved' as const, remainingMs: this.authorized ? 600_000 : 0 };
  }
  invalidateAuthorization() { this.authorized = false; this.stop(); }

  pause(): void { this.paused = true; }
  resume(): void {
    if (!this.authorized || this.stopped) throw new Error('engine_authorization_restart_required');
    this.paused = false;
  }
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

class FakeWebSocket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];
  static holdOpen = new Set<number>();
  static holdAuthorization = false;
  static rejectAuthorization = false;

  readonly messages: Array<string | Uint8Array> = [];
  readonly authorizationMessages: Array<{ type: string; access_token: string; engine: { sequence: number } }> = [];
  readyState = FakeWebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(readonly url: string) {
    super();
    const index = FakeWebSocket.instances.push(this) - 1;
    if (!FakeWebSocket.holdOpen.has(index)) queueMicrotask(() => this.open());
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.(new Event('open'));
    this.dispatchEvent(new Event('open'));
  }

  send(data: string | Uint8Array): void {
    if (typeof data === 'string') {
      const message = JSON.parse(data);
      if (['audio.authenticate', 'engine.renew'].includes(message.type)) {
        this.authorizationMessages.push(message);
        if (!FakeWebSocket.holdAuthorization) queueMicrotask(() => this.authorize());
        return;
      }
    }
    this.messages.push(data);
  }

  authorize(): void {
    const request = this.authorizationMessages.at(-1)!;
    const reply = FakeWebSocket.rejectAuthorization
      ? { type: 'system.error', message: ['engine_authentication_failed'] }
      : { type: request.type === 'engine.renew' ? 'engine.renewed' : 'engine.authorized', version: 1,
          sequence: request.engine.sequence, token: `permit-${request.engine.sequence}`, renew_after_ms: 540_000 };
    this.dispatchEvent(new MessageEvent('message', { data: JSON.stringify(reply) }));
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  serverClose(code: number, reason = ''): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason } as CloseEvent);
    this.dispatchEvent(Object.assign(new Event('close'), { code, reason }));
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

function setup(getAccessToken = () => 'login-token') {
  const api = new FakeApi();
  const capture = new FakeCapture();
  const session = new RealtimeTranslationSession(
    { websocketBaseUrl: 'wss://example.test' },
    api,
    async () => capture,
    getAccessToken,
    (url) => new FakeWebSocket(url) as unknown as WebSocket,
  );
  return { api, capture, session };
}

describe('RealtimeTranslationSession with the audio engine', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    FakeWebSocket.holdOpen = new Set();
    FakeWebSocket.holdAuthorization = false;
    FakeWebSocket.rejectAuthorization = false;
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
    expect(capture.stopped).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.getSnapshot().phase).toBe('recording');
    expect(capture.paused).toBe(false);

    capture.emit();
    const messages = FakeWebSocket.instances[3]?.messages ?? [];
    expect(readStatus(messages[0])).toMatchObject({ status_seq: 3, boundary_sample: 0, mic: { state: 'capturing' } });
    expect(messages[1]).toEqual(new Uint8Array([2]));
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

  it('waits for execution approval before starting native capture or sending audio status', async () => {
    FakeWebSocket.holdAuthorization = true;
    const { capture, session } = setup();
    const starting = session.start(input);
    await vi.waitFor(() => expect(FakeWebSocket.instances[1]?.authorizationMessages).toHaveLength(1));
    expect(capture.started).toBe(false);
    expect(FakeWebSocket.instances[1]?.messages).toEqual([]);
    FakeWebSocket.instances[1]!.authorize();
    await starting;
    expect(capture.started).toBe(true);
    await session.stop();
  });

  it('rejects initial authorization without starting native capture', async () => {
    FakeWebSocket.rejectAuthorization = true;
    const { api, capture, session } = setup();
    await session.start(input);
    expect(capture.started).toBe(false);
    expect(session.getSnapshot().phase).toBe('error');
    expect(api.ended).toEqual(['conversation-1']);
  });

  it('renews while paused using the current login credential, then invalidates on denial', async () => {
    vi.useFakeTimers();
    let token = 'first-login';
    const { capture, session } = setup(() => token);
    await session.start(input);
    await session.pause();
    token = 'fresh-login';
    await vi.advanceTimersByTimeAsync(480_000);
    const socket = FakeWebSocket.instances[1]!;
    expect(socket.authorizationMessages.at(-1)).toMatchObject({ type: 'engine.renew', access_token: 'fresh-login' });
    expect(capture.authorized).toBe(true);
    expect(session.getSnapshot().phase).toBe('paused');
    FakeWebSocket.rejectAuthorization = true;
    await vi.advanceTimersByTimeAsync(480_000);
    expect(capture.authorized).toBe(false);
    expect(capture.stopped).toBe(true);
    expect(session.getSnapshot().phase).toBe('error');
  });

  it('re-authorizes after reconnect while paused and starts only on resume', async () => {
    vi.useFakeTimers();
    const { capture, session } = setup();
    await session.start(input);
    await session.pause();
    FakeWebSocket.instances[1]!.serverClose(1006);
    expect(capture.authorized).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(capture.authorized).toBe(true);
    expect(capture.stopped).toBe(true);
    expect(session.getSnapshot().phase).toBe('paused');
    await session.resume();
    expect(capture.stopped).toBe(false);
    expect(session.getSnapshot().phase).toBe('recording');
    await session.stop();
  });

  it('ends the session if re-authorization is denied instead of repeatedly reconnecting', async () => {
    vi.useFakeTimers();
    const { api, capture, session } = setup();
    await session.start(input);
    FakeWebSocket.rejectAuthorization = true;
    FakeWebSocket.instances[1]!.serverClose(1006);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(session.getSnapshot().phase).toBe('error');
    expect(capture.stopped).toBe(true);
    expect(api.ended).toEqual(['conversation-1']);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(FakeWebSocket.instances).toHaveLength(4);
  });
});

function readStatus(value: string | Uint8Array | undefined): Record<string, any> {
  if (typeof value !== 'string') throw new Error('Expected JSON status');
  return JSON.parse(value) as Record<string, any>;
}
