import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRealtimeApi } from '../electron/realtimeApi';
import {
  RealtimeTranslationSession,
  type CaptureVadStatus,
  type CapturedAudioChunk,
  type MicrophoneCapture,
  type RealtimeWebSocket,
} from '../electron/realtime/RealtimeTranslationSession';

const HTTP_BASE_URL = 'https://example.test';
const END_PATH = '/conversations/conversation-1/end';
const ENDED_BY_SERVER = { phase: 'ended', error: null };
const RATE_LIMITED = 'audio_pipeline_activation_rate_limited';
const input = { sourceLanguage: 'ko-KR', targetLanguage: 'en-US', clientVad: true };

/** What the client sent, closed, and requested, in the order it happened. */
let timeline: string[];

/** The REST side of the server. Tests change these fields to script its answers. */
const server = {
  requests: [] as string[],
  settings: [] as unknown[],
  settingsStatus: 200,
  /** Statuses for the next `POST /end` calls; 200 once the list is empty. */
  endStatuses: [] as number[],
  /** Whether a successful `POST /end` is followed by `conversation.ended` and 1000 on Result. */
  sendsEnded: true,
};

class FakeCapture implements MicrophoneCapture {
  vadEnabled: boolean | null = null;
  paused = false;
  stopped = false;
  started = false;
  authorized = false;
  expired = false;
  sequence = 0;
  startError: Error | null = null;
  status: CaptureVadStatus = { vadReady: true, vadGateState: 'closed', vadProbability: 0, vadIsSpeech: false };
  private chunkCallback: ((error: Error | null, chunk: CapturedAudioChunk) => unknown) | null = null;
  private errorCallback: ((error: Error | null, detail: { message: string; recoverable: boolean }) => unknown) | null = null;
  private nextPayload = 1;

  /** True while the native engine delivers audio. */
  get capturing(): boolean {
    return this.started && !this.stopped && !this.paused;
  }

  onError(callback: (error: Error | null, detail: { message: string; recoverable: boolean }) => unknown): void {
    this.errorCallback = callback;
  }

  start(callback: (error: Error | null, chunk: CapturedAudioChunk) => unknown): void {
    if (this.startError) throw this.startError;
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
    this.expired = false;
    return this.getAuthorizationStatus();
  }
  getAuthorizationStatus() {
    if (this.expired) return { state: 'expired' as const, remainingMs: 0 };
    return { state: this.authorized ? 'authorized' as const : 'unapproved' as const, remainingMs: this.authorized ? 600_000 : 0 };
  }
  invalidateAuthorization() { this.authorized = false; this.stop(); }
  /** The native engine stops by itself when its permit runs out. */
  expire(): void { this.expired = true; this.stop(); }

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

type SocketEvent = 'open' | 'message' | 'close' | 'error';
type SocketListener = (event: any) => void;
interface AuthorizationRequest { type: string; access_token: string; engine: { sequence: number } }

/**
 * Calls its listeners the way the `ws` package does: one list per socket in the order they were
 * added, with an `on*` property as one entry of that list, and a listener that is removed while
 * an event is delivered still receives that event.
 */
class FakeSocket implements RealtimeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];
  /** What the server does with a new connection. Tests replace it to refuse or stall one. */
  static onConnect: (socket: FakeSocket) => void;
  /** What the server does with `audio.authenticate` and `engine.renew`. */
  static onAuthorize: (socket: FakeSocket) => void;

  readonly kind: 'result' | 'audio';
  /** `audio.status` messages and audio frames. */
  readonly sent: Array<string | Uint8Array> = [];
  readonly authorizationRequests: AuthorizationRequest[] = [];
  readyState = FakeSocket.CONNECTING;
  private listeners: Array<{ type: SocketEvent; listener: SocketListener; attribute: boolean }> = [];

  constructor(readonly url: string) {
    this.kind = url.includes('/audio?') ? 'audio' : 'result';
    FakeSocket.instances.push(this);
    queueMicrotask(() => FakeSocket.onConnect(this));
  }

  get onopen() { return this.attribute('open'); }
  set onopen(listener: SocketListener | null) { this.setAttribute('open', listener); }
  get onmessage() { return this.attribute('message'); }
  set onmessage(listener: SocketListener | null) { this.setAttribute('message', listener); }
  get onclose() { return this.attribute('close'); }
  set onclose(listener: SocketListener | null) { this.setAttribute('close', listener); }
  get onerror() { return this.attribute('error'); }
  set onerror(listener: SocketListener | null) { this.setAttribute('error', listener); }

  addEventListener(type: string, listener: SocketListener): void {
    this.listeners.push({ type: type as SocketEvent, listener, attribute: false });
  }

  removeEventListener(type: string, listener: SocketListener): void {
    this.listeners = this.listeners.filter(
      (item) => item.attribute || item.type !== type || item.listener !== listener,
    );
  }

  /** The server accepts the connection. Result then sends its ready message. */
  accept(): void {
    this.open();
    if (this.kind === 'result') this.receive({ type: 'participants.snapshot', data: {} });
  }

  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.emit('open', {});
  }

  receive(message: object): void {
    this.emit('message', { data: JSON.stringify(message) });
  }

  /** A close that the client did not start. */
  serverClose(code: number, reason = ''): void {
    this.readyState = FakeSocket.CLOSED;
    this.emit('close', { code, reason });
  }

  /** The server rejects the socket: `system.error`, then a close with the same reason. */
  refuse(code: number, reason: string, message: string, data: object = {}): void {
    this.receive(systemError(code, reason, message, data));
    this.serverClose(code, reason);
  }

  /** The server approves the engine request that is waiting for an answer. */
  authorize(): void {
    const request = this.authorizationRequests.at(-1)!;
    this.receive({
      type: request.type === 'engine.renew' ? 'engine.renewed' : 'engine.authorized',
      version: 1,
      sequence: request.engine.sequence,
      token: `permit-${request.engine.sequence}`,
      renew_after_ms: 540_000,
    });
  }

  /** The server answers the engine request with `engine.denied`. */
  deny(code: string, retryable = false): void {
    const sequence = this.authorizationRequests.at(-1)!.engine.sequence;
    this.receive({ type: 'engine.denied', version: 1, sequence, code, retryable });
  }

  send(data: string | Uint8Array): void {
    if (typeof data === 'string') {
      const message = JSON.parse(data) as AuthorizationRequest;
      if (['audio.authenticate', 'engine.renew'].includes(message.type)) {
        this.authorizationRequests.push(message);
        queueMicrotask(() => FakeSocket.onAuthorize(this));
        return;
      }
    }
    this.sent.push(data);
    timeline.push(typeof data === 'string' ? describeStatus(data) : 'audio frame');
  }

  close(): void {
    this.readyState = FakeSocket.CLOSED;
    timeline.push(`${this.kind} close`);
  }

  get detached(): boolean {
    return [this.onopen, this.onmessage, this.onclose, this.onerror].every((handler) => handler === null);
  }

  private attribute(type: SocketEvent): SocketListener | null {
    return this.listeners.find((item) => item.attribute && item.type === type)?.listener ?? null;
  }

  private setAttribute(type: SocketEvent, listener: SocketListener | null): void {
    this.listeners = this.listeners.filter((item) => !item.attribute || item.type !== type);
    if (listener) this.listeners.push({ type, listener, attribute: true });
  }

  private emit(type: SocketEvent, event: object): void {
    for (const item of [...this.listeners]) {
      if (item.type === type) item.listener(event);
    }
  }
}

function describeStatus(raw: string): string {
  const status = JSON.parse(raw) as { mic: { state: string }; vad: { event?: string } };
  return ['audio.status', status.mic.state, status.vad.event].filter(Boolean).join(' ');
}

function readStatus(value: string | Uint8Array | undefined): Record<string, any> {
  if (typeof value !== 'string') throw new Error('Expected JSON status');
  return JSON.parse(value) as Record<string, any>;
}

function reply(status: number, data: unknown = {}, message = 'ok'): Response {
  const body = JSON.stringify({ statusCode: String(status), message: [message], data });
  return { ok: status < 300, status, text: async () => body } as Response;
}

async function fakeFetch(url: string, init: RequestInit): Promise<Response> {
  const { pathname } = new URL(url);
  server.requests.push(`${init.method} ${pathname}`);
  timeline.push(`${init.method} ${pathname}`);
  if (pathname === '/conversations') return reply(200, { conversation_id: 'conversation-1' });
  if (pathname.endsWith('/interpretation-settings')) {
    if (server.settingsStatus !== 200) return reply(server.settingsStatus, null, 'Unsupported language.');
    server.settings.push(JSON.parse(String(init.body)));
  }
  if (pathname === END_PATH) {
    const status = server.endStatuses.shift() ?? 200;
    if (status === 503) return reply(503, null, 'Temporarily unavailable.');
    if (status !== 200) return reply(status, null, 'Conversation has already ended.');
    if (server.sendsEnded) {
      for (const socket of FakeSocket.instances.filter((item) => item.readyState === FakeSocket.OPEN)) {
        if (socket.kind === 'result') socket.receive({ type: 'conversation.ended', data: {} });
        socket.serverClose(1000, 'conversation_ended');
      }
    }
  }
  return reply(200);
}

function systemError(code: number, reason: string, message: string, data: object = {}) {
  return { type: 'system.error', statusCode: String(code), message: [message], data: { reason, ...data } };
}

function result(eventType: string, orderSeq: number, text: string, targetLanguage: string | null = null) {
  return {
    type: 'result',
    statusCode: '200',
    message: ['ok'],
    data: {
      conversation_id: 'conversation-1',
      event_type: eventType,
      order_seq: orderSeq,
      text,
      source_language: 'ko-KR',
      target_language: targetLanguage,
    },
  };
}

function createSession(getAccessToken: () => string = () => 'login-token') {
  const capture = new FakeCapture();
  const session = new RealtimeTranslationSession(
    { websocketBaseUrl: 'wss://example.test' },
    createRealtimeApi({ httpBaseUrl: HTTP_BASE_URL, accessToken: 'token' }, fakeFetch),
    async () => capture,
    getAccessToken,
    (url) => new FakeSocket(url),
  );
  return { session, capture };
}

async function startSession(clientVad = false, getAccessToken?: () => string) {
  const created = createSession(getAccessToken);
  await created.session.start({ ...input, clientVad });
  const [resultSocket, audioSocket] = FakeSocket.instances;
  return { ...created, resultSocket: resultSocket!, audioSocket: audioSocket! };
}

/** Runs everything that is ready to run without moving the clock. */
const flush = () => vi.advanceTimersByTimeAsync(0);
const endRequests = () => server.requests.filter((request) => request === `POST ${END_PATH}`);
const socketKinds = () => FakeSocket.instances.map((socket) => socket.kind);
const latest = () => FakeSocket.instances.at(-1)!;
const frames = (socket: FakeSocket) => socket.sent.filter((item) => item instanceof Uint8Array);

/** Checks that the next socket is opened exactly `delayMs` from now, and returns it. */
async function reopenedAfter(delayMs: number): Promise<FakeSocket> {
  const count = FakeSocket.instances.length;
  await vi.advanceTimersByTimeAsync(delayMs - 1);
  expect(FakeSocket.instances).toHaveLength(count);
  await vi.advanceTimersByTimeAsync(1);
  expect(FakeSocket.instances.length).toBeGreaterThan(count);
  return latest();
}

beforeEach(() => {
  vi.useFakeTimers();
  timeline = [];
  Object.assign(server, {
    requests: [],
    settings: [],
    settingsStatus: 200,
    endStatuses: [],
    sendsEnded: true,
  });
  FakeSocket.instances = [];
  FakeSocket.onConnect = (socket) => socket.accept();
  FakeSocket.onAuthorize = (socket) => socket.authorize();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('RealtimeTranslationSession with the audio engine', () => {
  it('sends each gate transition before the frame it applies to, counting samples from the socket start', async () => {
    const { session, capture, audioSocket } = await startSession(true);

    capture.emit();
    capture.emit('speech_gate_opened');
    capture.emit();
    capture.emit('speech_gate_closed');

    expect(audioSocket.url).toBe('wss://example.test/audio?conversation_id=conversation-1&audio_format=opus');
    expect(capture.vadEnabled).toBe(true);
    expect(server.settings).toEqual([
      { languages: ['ko-KR', 'en-US'], transcription: { client_vad: true }, translation: {} },
    ]);
    const messages = audioSocket.sent;
    expect(readStatus(messages[0])).toMatchObject({ status_seq: 1, boundary_sample: 0, mic: { state: 'capturing' } });
    expect(messages[1]).toEqual(new Uint8Array([1]));
    expect(readStatus(messages[2])).toMatchObject({ status_seq: 2, boundary_sample: 320, vad: { event: 'speech_gate_opened' } });
    expect(messages[3]).toEqual(new Uint8Array([2]));
    expect(messages[4]).toEqual(new Uint8Array([3]));
    expect(readStatus(messages[5])).toMatchObject({ status_seq: 3, boundary_sample: 960, vad: { event: 'speech_gate_closed' } });
    expect(messages[6]).toEqual(new Uint8Array([4]));
    expect(session.getSnapshot().vad).toMatchObject({ enabled: true, ready: true, gate: 'closed' });

    await session.stop();
    expect(endRequests()).toHaveLength(1);
    expect(capture.stopped).toBe(true);
    expect(readStatus(messages.at(-1))).toMatchObject({ mic: { state: 'idle' } });
    expect(session.getSnapshot().phase).toBe('ended');
  });

  it('turns the engine gate off for server VAD', async () => {
    const { session, capture, audioSocket } = await startSession(false);
    capture.emit();

    const messages = audioSocket.sent;
    expect(capture.vadEnabled).toBe(false);
    expect(readStatus(messages[0])).toMatchObject({ vad: { enabled: false } });
    expect(messages[1]).toEqual(new Uint8Array([1]));
    expect(session.getSnapshot().vad.mode).toBe('disabled');
    await session.stop();
  });

  it('closes an open boundary before pausing and re-opens it when speech continues after resume', async () => {
    const { session, capture, audioSocket } = await startSession(true);
    capture.emit('speech_gate_opened');
    await session.pause();

    const messages = audioSocket.sent;
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
    const { session, capture, audioSocket } = await startSession(true);
    capture.emit('speech_gate_opened');
    audioSocket.serverClose(1006);

    expect(session.getSnapshot().phase).toBe('reconnecting');
    expect(capture.stopped).toBe(true);
    const reopened = await reopenedAfter(1_000);
    expect(session.getSnapshot().phase).toBe('recording');
    expect(capture.paused).toBe(false);

    capture.emit();
    const messages = reopened.sent;
    expect(readStatus(messages[0])).toMatchObject({ status_seq: 3, boundary_sample: 0, mic: { state: 'capturing' } });
    expect(messages[1]).toEqual(new Uint8Array([2]));
    await session.stop();
  });

  it('ends the conversation when the engine reports a fatal capture error', async () => {
    const { session, capture } = await startSession(true);
    capture.fail('device lost');
    await flush();

    expect(session.getSnapshot()).toMatchObject({ phase: 'error', error: 'Audio capture failed: device lost' });
    expect(endRequests()).toHaveLength(1);
  });

  it('shows a malformed Result message as an error and keeps the session running', async () => {
    const { session, capture, resultSocket } = await startSession();
    resultSocket.receive({ type: 'result', data: { event_type: 'transcript.final' } });

    expect(session.getSnapshot()).toMatchObject({
      phase: 'recording',
      error: 'Invalid Result WebSocket payload.',
      resultConnection: 'open',
      audioConnection: 'open',
    });
    expect(capture.capturing).toBe(true);
    resultSocket.receive(result('transcript.final', 0, '안녕하세요.'));
    expect(session.getSnapshot().rows).toHaveLength(1);
    expect(endRequests()).toEqual([]);
  });

  it('rejects identical languages without creating a conversation', async () => {
    const { session } = createSession();
    await session.start({ ...input, targetLanguage: 'ko-KR' });

    expect(session.getSnapshot()).toMatchObject({ phase: 'idle', error: 'Select two different languages.' });
    expect(server.requests).toEqual([]);
  });
});

describe('RealtimeTranslationSession engine authorization', () => {
  it('waits for execution approval before starting native capture or sending audio status', async () => {
    FakeSocket.onAuthorize = () => {};
    const { session, capture } = createSession();
    const starting = session.start(input);
    await flush();
    const audioSocket = latest();
    expect(audioSocket.authorizationRequests).toMatchObject([{ type: 'audio.authenticate', access_token: 'login-token' }]);
    expect(capture.started).toBe(false);
    expect(audioSocket.sent).toEqual([]);
    expect(session.getSnapshot()).toMatchObject({ phase: 'connecting', audioConnection: 'open' });

    audioSocket.authorize();
    await starting;
    expect(capture.started).toBe(true);
    await session.stop();
  });

  it('fails the start with the server message when the initial authorization is refused', async () => {
    FakeSocket.onAuthorize = (socket) =>
      socket.refuse(1008, 'engine_authentication_failed', 'The login token is not valid.');
    const { session, capture } = createSession();
    await session.start(input);
    await flush();

    expect(capture.started).toBe(false);
    expect(session.getSnapshot()).toMatchObject({
      phase: 'error',
      error: 'The login token is not valid. (engine_authentication_failed)',
    });
    expect(endRequests()).toHaveLength(1);
  });

  it('fails the start when the authorization is not answered within its 10 seconds', async () => {
    FakeSocket.onAuthorize = () => {};
    const { session, capture } = createSession();
    const starting = session.start(input);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(session.getSnapshot().phase).toBe('connecting');
    await vi.advanceTimersByTimeAsync(1);
    await starting;

    expect(session.getSnapshot()).toMatchObject({
      phase: 'error',
      error: 'The realtime connection closed while starting. (audio closed: 1006)',
    });
    expect(capture.started).toBe(false);
    expect(endRequests()).toHaveLength(1);
  });

  it('gives the authorization its own 10 seconds after /audio opened', async () => {
    FakeSocket.onConnect = (socket) => {
      if (socket.kind === 'result') socket.accept();
    };
    FakeSocket.onAuthorize = () => {};
    const { session, capture } = createSession();
    const starting = session.start(input);
    await vi.advanceTimersByTimeAsync(6_000);
    const audioSocket = latest();
    audioSocket.accept();
    // 12 seconds after the socket was created, 6 seconds after it opened.
    await vi.advanceTimersByTimeAsync(6_000);
    expect(session.getSnapshot()).toMatchObject({ phase: 'connecting', audioConnection: 'open' });

    audioSocket.authorize();
    await starting;
    expect(session.getSnapshot().phase).toBe('recording');
    expect(capture.capturing).toBe(true);
  });

  it('renews while paused using the current login credential, and stops when the renewal is refused', async () => {
    let token = 'first-login';
    const { session, capture, audioSocket } = await startSession(true, () => token);
    await session.pause();
    token = 'fresh-login';
    await vi.advanceTimersByTimeAsync(480_000);
    expect(audioSocket.authorizationRequests.at(-1)).toMatchObject({ type: 'engine.renew', access_token: 'fresh-login' });
    expect(capture.authorized).toBe(true);
    expect(session.getSnapshot().phase).toBe('paused');

    FakeSocket.onAuthorize = (socket) =>
      socket.refuse(1008, 'engine_authentication_failed', 'The login token is not valid.');
    await vi.advanceTimersByTimeAsync(480_000);
    expect(capture.authorized).toBe(false);
    expect(capture.stopped).toBe(true);
    expect(session.getSnapshot()).toMatchObject({
      phase: 'error',
      error: 'The login token is not valid. (engine_authentication_failed)',
    });
    expect(endRequests()).toHaveLength(1);
  });

  it('leaves a retryable renewal denial to the authorization module', async () => {
    const { session, capture, audioSocket } = await startSession();
    FakeSocket.onAuthorize = (socket) => socket.deny('engine_authorization_unavailable', true);
    await vi.advanceTimersByTimeAsync(480_000);
    expect(audioSocket.authorizationRequests).toHaveLength(2);
    expect(session.getSnapshot()).toMatchObject({ phase: 'recording', error: null });
    expect(capture.capturing).toBe(true);

    // The module asks again one second later, on the same socket.
    FakeSocket.onAuthorize = (socket) => socket.authorize();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(audioSocket.authorizationRequests).toHaveLength(3);
    expect(socketKinds()).toEqual(['result', 'audio']);
    expect(capture.authorized).toBe(true);
  });

  it('re-authorizes after reconnect while paused and starts only on resume', async () => {
    const { session, capture, audioSocket } = await startSession(true);
    await session.pause();
    audioSocket.serverClose(1006);
    expect(capture.authorized).toBe(false);
    await reopenedAfter(1_000);
    expect(capture.authorized).toBe(true);
    expect(capture.stopped).toBe(true);
    expect(session.getSnapshot().phase).toBe('paused');
    await session.resume();
    expect(capture.stopped).toBe(false);
    expect(session.getSnapshot().phase).toBe('recording');
    await session.stop();
  });

  it('ends the session if re-authorization is refused instead of repeatedly reconnecting', async () => {
    const { session, capture, audioSocket } = await startSession(true);
    FakeSocket.onAuthorize = (socket) =>
      socket.refuse(1008, 'engine_authentication_failed', 'The login token is not valid.');
    audioSocket.serverClose(1006);
    await reopenedAfter(1_000);
    expect(session.getSnapshot()).toMatchObject({
      phase: 'error',
      error: 'The login token is not valid. (engine_authentication_failed)',
    });
    expect(capture.stopped).toBe(true);
    expect(endRequests()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    // Only `/audio` was reopened, once.
    expect(socketKinds()).toEqual(['result', 'audio', 'audio']);
  });

  it('keeps the system.error of /audio for the close that follows, although capture has already stopped', async () => {
    const { session, capture, audioSocket } = await startSession();
    audioSocket.receive(systemError(1013, 'worker_capacity_exceeded', 'No worker capacity.'));
    await flush();
    // The authorization module gave the socket up, which stops native capture. Nothing is shown.
    expect(capture.authorized).toBe(false);
    expect(session.getSnapshot()).toMatchObject({ phase: 'recording', error: null, audioConnection: 'open' });

    // Like `reconnecting`, Pause waits for the close to be handled.
    await session.pause();
    expect(session.getSnapshot().phase).toBe('recording');

    audioSocket.serverClose(1013, 'worker_capacity_exceeded');
    await flush();
    expect(session.getSnapshot()).toMatchObject({ phase: 'reconnecting', error: null });
    expect(endRequests()).toEqual([]);

    await reopenedAfter(1_000);
    expect(session.getSnapshot()).toMatchObject({ phase: 'recording' });
    expect(capture.capturing).toBe(true);
    // The one close was handled once: no second reconnect is waiting.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socketKinds()).toEqual(['result', 'audio', 'audio']);
  });

  it('handles a system.error that no close follows like a lost connection, 10 seconds later', async () => {
    const { session, audioSocket } = await startSession();
    audioSocket.receive(systemError(1011, 'internal_error', 'Internal error.'));
    await vi.advanceTimersByTimeAsync(9_999);
    expect(session.getSnapshot()).toMatchObject({ phase: 'recording', audioConnection: 'open' });
    await vi.advanceTimersByTimeAsync(1);

    expect(audioSocket.readyState).toBe(FakeSocket.CLOSED);
    expect(audioSocket.detached).toBe(true);
    expect(session.getSnapshot()).toMatchObject({ phase: 'reconnecting' });
    await reopenedAfter(1_000);
    expect(session.getSnapshot()).toMatchObject({ phase: 'recording' });
  });

  it.each([
    ['in the same tick', false],
    ['after the authorization module reported it', true],
  ])('shows the Conversation as ended when a new /audio is refused before approval, the close arriving %s', async (_case, later) => {
    const { session, audioSocket } = await startSession();
    FakeSocket.onAuthorize = (socket) => {
      socket.receive(systemError(1008, 'conversation_ended', 'Conversation has already ended.'));
      // The close frame carries no reason here; the system.error that was kept supplies it.
      if (later) queueMicrotask(() => socket.serverClose(1008));
      else socket.serverClose(1008);
    };
    audioSocket.serverClose(1006);
    await reopenedAfter(1_000);

    expect(session.getSnapshot()).toMatchObject({
      ...ENDED_BY_SERVER,
      resultConnection: 'closed',
      audioConnection: 'closed',
    });
    expect(endRequests()).toEqual([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socketKinds()).toEqual(['result', 'audio', 'audio']);
  });

  it('keeps reconnecting when the server approves the new /audio socket and refuses it right away', async () => {
    const { session, capture, audioSocket } = await startSession();
    FakeSocket.onAuthorize = (socket) => {
      socket.authorize();
      socket.receive(
        systemError(1013, RATE_LIMITED, 'Audio pipeline reconnect rate limit exceeded.', { retry_after_ms: 800 }),
      );
    };
    audioSocket.serverClose(1006);
    const refused = await reopenedAfter(1_000);
    // Approved, but given up in the same tick: capture does not start on this socket.
    expect(session.getSnapshot()).toMatchObject({ phase: 'reconnecting', error: null });
    expect(capture.capturing).toBe(false);

    refused.serverClose(1013, RATE_LIMITED);
    await flush();
    expect(session.getSnapshot()).toMatchObject({ phase: 'reconnecting', error: null });
    expect(capture.capturing).toBe(false);

    FakeSocket.onAuthorize = (socket) => socket.authorize();
    await reopenedAfter(2_000);
    expect(session.getSnapshot()).toMatchObject({ phase: 'recording' });
    expect(capture.capturing).toBe(true);
  });

  it('reconnects when the authorization of a new /audio socket times out', async () => {
    const { session, capture, audioSocket } = await startSession();
    FakeSocket.onAuthorize = () => {};
    audioSocket.serverClose(1006);
    const unanswered = await reopenedAfter(1_000);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(unanswered.readyState).toBe(FakeSocket.OPEN);
    await vi.advanceTimersByTimeAsync(1);

    expect(unanswered.readyState).toBe(FakeSocket.CLOSED);
    expect(unanswered.detached).toBe(true);
    expect(session.getSnapshot()).toMatchObject({ phase: 'reconnecting', error: null });

    FakeSocket.onAuthorize = (socket) => socket.authorize();
    await reopenedAfter(2_000);
    expect(session.getSnapshot()).toMatchObject({ phase: 'recording' });
    expect(capture.capturing).toBe(true);
    expect(endRequests()).toEqual([]);
  });

  it.each([
    ['engine.denied', 'engine_access_denied', (socket: FakeSocket) => socket.deny('engine_access_denied')],
    [
      'a reply without a permit',
      'engine_authorization_response_invalid',
      (socket: FakeSocket) => socket.receive({
        type: 'engine.authorized',
        version: 1,
        sequence: socket.authorizationRequests.at(-1)!.engine.sequence,
      }),
    ],
  ])('ends the session when a new /audio socket gets %s', async (_case, error, answer) => {
    const { session, capture, audioSocket } = await startSession();
    FakeSocket.onAuthorize = answer;
    audioSocket.serverClose(1006);
    await reopenedAfter(1_000);

    expect(session.getSnapshot()).toMatchObject({ phase: 'error', error });
    expect(capture.capturing).toBe(false);
    expect(endRequests()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socketKinds()).toEqual(['result', 'audio', 'audio']);
  });

  it('ends the session when a renewal is denied for good', async () => {
    const { session, capture } = await startSession();
    FakeSocket.onAuthorize = (socket) => socket.deny('engine_access_denied');
    await vi.advanceTimersByTimeAsync(480_000);

    expect(session.getSnapshot()).toMatchObject({ phase: 'error', error: 'engine_access_denied' });
    expect(capture.capturing).toBe(false);
    expect(endRequests()).toHaveLength(1);
    expect(socketKinds()).toEqual(['result', 'audio']);
  });

  it('reopens only /audio when the module finds the permit expired, and stops once the login token is refused', async () => {
    const { session, capture, resultSocket, audioSocket } = await startSession();
    // The renewal fails for now, and the native permit runs out before another one succeeds.
    const failRenewalUntilExpiry = (socket: FakeSocket) => {
      capture.expire();
      socket.deny('engine_authorization_unavailable', true);
    };
    FakeSocket.onAuthorize = failRenewalUntilExpiry;
    await vi.advanceTimersByTimeAsync(480_000);
    expect(session.getSnapshot()).toMatchObject({
      phase: 'reconnecting',
      error: null,
      resultConnection: 'open',
      audioConnection: 'closed',
    });
    expect(audioSocket.detached).toBe(true);
    expect(resultSocket.detached).toBe(false);

    FakeSocket.onAuthorize = (socket) => socket.authorize();
    await reopenedAfter(1_000);
    expect(socketKinds()).toEqual(['result', 'audio', 'audio']);
    expect(session.getSnapshot()).toMatchObject({ phase: 'recording' });
    expect(capture.capturing).toBe(true);
    expect(endRequests()).toEqual([]);

    // With an expired login token the server refuses the new socket, which ends the reconnects.
    FakeSocket.onAuthorize = failRenewalUntilExpiry;
    await vi.advanceTimersByTimeAsync(480_000);
    expect(session.getSnapshot().phase).toBe('reconnecting');
    FakeSocket.onAuthorize = (socket) =>
      socket.refuse(1008, 'engine_authentication_failed', 'The login token is not valid.');
    await reopenedAfter(1_000);
    expect(session.getSnapshot()).toMatchObject({
      phase: 'error',
      error: 'The login token is not valid. (engine_authentication_failed)',
    });
    expect(endRequests()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socketKinds()).toEqual(['result', 'audio', 'audio', 'audio']);
  });

  it('shows the Conversation as ended after 1008 engine_conversation_inactive', async () => {
    const { session, audioSocket } = await startSession();
    audioSocket.refuse(1008, 'engine_conversation_inactive', 'The Conversation is not active.');
    await flush();

    expect(session.getSnapshot()).toMatchObject(ENDED_BY_SERVER);
    expect(endRequests()).toEqual([]);
  });

  it('stops but leaves the Conversation open after 1008 engine_connection_superseded', async () => {
    const { session, audioSocket } = await startSession();
    audioSocket.refuse(1008, 'engine_connection_superseded', 'A newer audio connection replaced this one.');
    await flush();

    expect(session.getSnapshot()).toMatchObject({
      phase: 'error',
      error: 'Another device or tab took over the audio of this Conversation.',
    });
    expect(endRequests()).toEqual([]);
  });

  it('reopens /audio and authorizes again after 1008 engine_authorization_expired', async () => {
    const { session, capture, audioSocket } = await startSession();
    audioSocket.refuse(1008, 'engine_authorization_expired', 'The engine authorization expired.');
    await flush();
    expect(session.getSnapshot()).toMatchObject({ phase: 'reconnecting', error: null });

    const reopened = await reopenedAfter(1_000);
    expect(reopened.authorizationRequests).toMatchObject([{ type: 'audio.authenticate' }]);
    expect(session.getSnapshot()).toMatchObject({ phase: 'recording' });
    expect(capture.capturing).toBe(true);
    expect(endRequests()).toEqual([]);
  });
});

describe('RealtimeTranslationSession when the Conversation ends on the server', () => {
  it.each([
    'result',
    'audio',
  ] as const)('shows it as ended, without POST /end, when %s closes with 1000', async (kind) => {
    const { session, capture, resultSocket, audioSocket } = await startSession();
    (kind === 'result' ? resultSocket : audioSocket).serverClose(1000, 'conversation_ended');
    await flush();

    expect(session.getSnapshot()).toMatchObject({
      ...ENDED_BY_SERVER,
      resultConnection: 'closed',
      audioConnection: 'closed',
    });
    expect(endRequests()).toEqual([]);
    expect(capture.capturing).toBe(false);
    expect([resultSocket.readyState, audioSocket.readyState]).toEqual([FakeSocket.CLOSED, FakeSocket.CLOSED]);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(socketKinds()).toEqual(['result', 'audio']);
  });

  it('takes the same path for conversation.ended', async () => {
    const { session, resultSocket, audioSocket } = await startSession();
    resultSocket.receive({ type: 'conversation.ended', data: { conversation_id: 'conversation-1' } });
    // Both sockets are detached at once, so the 1000 that follows is not handled a second time.
    expect([resultSocket.detached, audioSocket.detached]).toEqual([true, true]);
    await flush();

    expect(session.getSnapshot()).toMatchObject(ENDED_BY_SERVER);
    expect(endRequests()).toEqual([]);
  });

  it('treats system.error conversation_ended followed by 1008 as ended', async () => {
    const { session, resultSocket } = await startSession();
    resultSocket.receive(systemError(1008, 'conversation_ended', 'Conversation has already ended.'));
    expect(session.getSnapshot()).toMatchObject({ phase: 'recording', error: null });
    resultSocket.serverClose(1008);
    await flush();

    expect(session.getSnapshot()).toMatchObject(ENDED_BY_SERVER);
    expect(endRequests()).toEqual([]);
  });

  it('treats 1008 as ended from the close reason alone, without a system.error', async () => {
    const { session, audioSocket } = await startSession();
    audioSocket.serverClose(1008, 'conversation_ended');
    await flush();

    expect(session.getSnapshot()).toMatchObject(ENDED_BY_SERVER);
    expect(endRequests()).toEqual([]);
  });
});

describe('RealtimeTranslationSession when the server refuses a socket', () => {
  it('stops with the server message and calls POST /end after 1008 interpretation_settings_changed', async () => {
    const { session, capture, audioSocket } = await startSession();
    audioSocket.receive(
      systemError(1008, 'interpretation_settings_changed', 'Interpretation worker revision conflict.'),
    );
    // The message alone changes nothing; the close decides.
    expect(session.getSnapshot()).toMatchObject({ phase: 'recording', error: null });
    audioSocket.serverClose(1008, 'interpretation_settings_changed');
    await flush();

    expect(session.getSnapshot()).toMatchObject({
      phase: 'error',
      error: 'Interpretation worker revision conflict. (interpretation_settings_changed)',
      resultConnection: 'closed',
      audioConnection: 'closed',
    });
    expect(endRequests()).toHaveLength(1);
    expect(capture.capturing).toBe(false);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(socketKinds()).toEqual(['result', 'audio']);
  });

  it('stops but leaves the Conversation open after 1008 audio_connection_replaced', async () => {
    const { session, audioSocket } = await startSession();
    audioSocket.refuse(1008, 'audio_connection_replaced', 'Audio connection was replaced.');
    await flush();

    expect(session.getSnapshot()).toMatchObject({
      phase: 'error',
      error: 'Another device or tab took over the audio of this Conversation.',
    });
    // Quitting the app calls stop(); that must not end the Conversation either.
    await session.stop({ waitForResults: false });
    expect(endRequests()).toEqual([]);
  });
});

describe('RealtimeTranslationSession reconnects', () => {
  it('reopens only /audio, after retry_after_ms, authorizes it, and restarts capture from sample 0', async () => {
    const { session, capture, resultSocket, audioSocket } = await startSession(true);
    capture.emit('speech_gate_opened');
    capture.emit();

    audioSocket.receive(
      systemError(1013, RATE_LIMITED, 'Audio pipeline reconnect rate limit exceeded.', { retry_after_ms: 3_000 }),
    );
    audioSocket.serverClose(1013, RATE_LIMITED);
    await flush();
    expect(session.getSnapshot()).toMatchObject({
      phase: 'reconnecting',
      error: null,
      resultConnection: 'open',
      audioConnection: 'closed',
    });
    expect(capture.capturing).toBe(false);
    expect(capture.authorized).toBe(false);
    expect(endRequests()).toEqual([]);

    const reopened = await reopenedAfter(3_000);
    expect(socketKinds()).toEqual(['result', 'audio', 'audio']);
    expect(resultSocket.readyState).toBe(FakeSocket.OPEN);
    expect(resultSocket.detached).toBe(false);
    expect(session.getSnapshot()).toMatchObject({ phase: 'recording', audioConnection: 'open' });
    expect(reopened.authorizationRequests).toMatchObject([{ type: 'audio.authenticate' }]);
    expect(capture.authorized).toBe(true);
    expect(capture.capturing).toBe(true);

    capture.emit('speech_gate_opened');
    // Status first, then the gate event of the restarted capture, both counted from sample 0 again.
    const [status, gateOpened, frame] = reopened.sent;
    expect(readStatus(status)).toMatchObject({ boundary_sample: 0, mic: { state: 'capturing' } });
    expect(readStatus(gateOpened)).toMatchObject({ boundary_sample: 0, vad: { event: 'speech_gate_opened' } });
    expect(frame).toBeInstanceOf(Uint8Array);
    // status_seq keeps counting through the Conversation.
    expect(readStatus(status).status_seq).toBeGreaterThan(readStatus(audioSocket.sent[0]).status_seq);

    // The rate limit belonged to the old socket: the next close uses the plain backoff.
    reopened.serverClose(1006);
    await reopenedAfter(2_000);
  });

  it('keeps the authorization, capture, and /audio while only Result reconnects, and shows only later results', async () => {
    const { session, capture, resultSocket, audioSocket } = await startSession();
    resultSocket.receive(result('transcript.final', 0, '안녕하세요.'));
    resultSocket.serverClose(1013, 'result_send_failed');
    await flush();
    expect(session.getSnapshot()).toMatchObject({
      phase: 'recording',
      error: null,
      resultConnection: 'closed',
      audioConnection: 'open',
    });
    expect(capture.authorized).toBe(true);
    expect(capture.capturing).toBe(true);

    capture.emit();
    expect(audioSocket.sent.at(-1)).toBeInstanceOf(Uint8Array);

    const reopened = await reopenedAfter(1_000);
    expect(socketKinds()).toEqual(['result', 'audio', 'result']);
    expect(audioSocket.readyState).toBe(FakeSocket.OPEN);
    expect(audioSocket.detached).toBe(false);
    expect(audioSocket.authorizationRequests).toHaveLength(1);
    expect(session.getSnapshot()).toMatchObject({ phase: 'recording', resultConnection: 'open' });

    // What the server sent while Result was closed is not recovered: no request is made for it.
    reopened.receive(result('transcript.final', 2, '다시 연결되었습니다.'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(session.getSnapshot().rows).toMatchObject([
      { orderSeq: 0, source: { text: '안녕하세요.', isFinal: true }, translations: {} },
      { orderSeq: 2, source: { text: '다시 연결되었습니다.', isFinal: true } },
    ]);
    expect(server.requests.filter((request) => request.startsWith('GET'))).toEqual([]);

    capture.emit();
    expect(frames(audioSocket)).toHaveLength(2);
    expect(capture.capturing).toBe(true);
  });

  it('opens Result first when both sockets closed, and /audio only after Result is ready', async () => {
    const { session, resultSocket, audioSocket } = await startSession();
    FakeSocket.onConnect = () => {};
    resultSocket.serverClose(1006);
    audioSocket.serverClose(1006);
    await flush();
    expect(session.getSnapshot()).toMatchObject({
      phase: 'reconnecting',
      resultConnection: 'closed',
      audioConnection: 'closed',
    });

    const reopenedResult = await reopenedAfter(1_000);
    reopenedResult.open();
    await flush();
    expect(socketKinds()).toEqual(['result', 'audio', 'result']);

    reopenedResult.receive({ type: 'participants.snapshot', data: {} });
    await flush();
    expect(socketKinds()).toEqual(['result', 'audio', 'result', 'audio']);
    expect(session.getSnapshot()).toMatchObject({ phase: 'reconnecting', resultConnection: 'open' });

    latest().accept();
    await flush();
    expect(session.getSnapshot()).toMatchObject({ phase: 'recording', audioConnection: 'open' });
  });

  it('adds a socket that closes during the wait to the pending reconnect, keeping its timer', async () => {
    const { resultSocket, audioSocket } = await startSession();
    resultSocket.serverClose(1006);
    await vi.advanceTimersByTimeAsync(600);
    audioSocket.serverClose(1006);
    await reopenedAfter(400);
    expect(socketKinds()).toEqual(['result', 'audio', 'result', 'audio']);

    // The two closes counted as one attempt, so the next wait is the second backoff step.
    latest().serverClose(1006);
    await reopenedAfter(2_000);
  });

  it('leaves a socket that closes during an attempt to the next attempt and its own delay', async () => {
    const { session, resultSocket, audioSocket } = await startSession();
    FakeSocket.onConnect = () => {};
    resultSocket.serverClose(1006);
    const reopenedResult = await reopenedAfter(1_000);

    audioSocket.refuse(1013, RATE_LIMITED, 'Audio pipeline reconnect rate limit exceeded.', { retry_after_ms: 3_000 });
    reopenedResult.accept();
    await flush();
    expect(socketKinds()).toEqual(['result', 'audio', 'result']);
    expect(session.getSnapshot()).toMatchObject({ phase: 'reconnecting', resultConnection: 'open' });

    (await reopenedAfter(3_000)).accept();
    await flush();
    expect(socketKinds()).toEqual(['result', 'audio', 'result', 'audio']);
    expect(session.getSnapshot()).toMatchObject({ phase: 'recording' });
  });

  it('runs one attempt at a time, so a later timer does not replace a socket that is opening', async () => {
    const { session, resultSocket, audioSocket } = await startSession();
    FakeSocket.onConnect = () => {};
    resultSocket.serverClose(1006);
    const opening = await reopenedAfter(1_000);

    audioSocket.serverClose(1006);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(socketKinds()).toEqual(['result', 'audio', 'result']);
    expect(opening.detached).toBe(false);

    opening.accept();
    await flush();
    latest().accept();
    await flush();
    expect(socketKinds()).toEqual(['result', 'audio', 'result', 'audio']);
    expect(session.getSnapshot()).toMatchObject({ phase: 'recording' });
  });

  it('keeps reconnecting when the server accepts the new /audio socket and refuses it right away', async () => {
    const { session, capture, audioSocket } = await startSession();
    FakeSocket.onConnect = (socket) => {
      socket.accept();
      socket.refuse(1013, RATE_LIMITED, 'Audio pipeline reconnect rate limit exceeded.', { retry_after_ms: 800 });
    };
    audioSocket.serverClose(1006);
    await reopenedAfter(1_000);
    expect(session.getSnapshot()).toMatchObject({
      phase: 'reconnecting',
      error: null,
      audioConnection: 'closed',
    });
    expect(capture.capturing).toBe(false);

    FakeSocket.onConnect = (socket) => socket.accept();
    await reopenedAfter(2_000);
    expect(session.getSnapshot()).toMatchObject({ phase: 'recording' });
    expect(capture.capturing).toBe(true);
  });

  it('ends the session when capture cannot be started again after reconnecting', async () => {
    const { session, capture, audioSocket } = await startSession();
    capture.startError = new Error('Unable to restart the audio capture.');
    audioSocket.serverClose(1006);
    await reopenedAfter(1_000);

    expect(session.getSnapshot()).toMatchObject({
      phase: 'error',
      error: 'Unable to restart the audio capture.',
    });
    expect(endRequests()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socketKinds()).toEqual(['result', 'audio', 'audio']);
  });

  it('backs off further when a reopened socket closes again, and starts over after 30 stable seconds', async () => {
    const { audioSocket } = await startSession();
    audioSocket.serverClose(1011);
    let reopened = await reopenedAfter(1_000);

    reopened.serverClose(1011);
    reopened = await reopenedAfter(2_000);

    await vi.advanceTimersByTimeAsync(29_999);
    reopened.serverClose(1011);
    reopened = await reopenedAfter(5_000);

    await vi.advanceTimersByTimeAsync(30_000);
    reopened.serverClose(1011);
    await reopenedAfter(1_000);
  });

  it('gives up an attempt that does not open within 10 seconds and ignores that socket afterwards', async () => {
    const { session, audioSocket } = await startSession();
    FakeSocket.onConnect = () => {};
    audioSocket.serverClose(1006);
    const stalled = await reopenedAfter(1_000);

    await vi.advanceTimersByTimeAsync(10_000);
    expect(stalled.readyState).toBe(FakeSocket.CLOSED);
    expect(stalled.detached).toBe(true);
    expect(session.getSnapshot()).toMatchObject({ phase: 'reconnecting', audioConnection: 'closed' });

    FakeSocket.onConnect = (socket) => socket.accept();
    await reopenedAfter(2_000);
    stalled.serverClose(1008, 'audio_pipeline_fenced');
    await flush();
    expect(session.getSnapshot()).toMatchObject({
      phase: 'recording',
      error: null,
      audioConnection: 'open',
    });
    expect(socketKinds()).toEqual(['result', 'audio', 'audio', 'audio']);
  });

  it('cancels a pending reconnect on Stop', async () => {
    server.sendsEnded = false;
    const { session, audioSocket } = await startSession();
    audioSocket.serverClose(1006);
    const stopped = session.stop();
    await flush();
    expect(session.getSnapshot()).toMatchObject({ phase: 'stopping' });
    await vi.advanceTimersByTimeAsync(5_000);
    await stopped;

    expect(session.getSnapshot()).toMatchObject({ phase: 'ended', error: null });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socketKinds()).toEqual(['result', 'audio']);
  });
});

describe('RealtimeTranslationSession while starting', () => {
  const start = (session: RealtimeTranslationSession) => session.start({ ...input, clientVad: false });

  it('fails the start with the server message when /audio is accepted and then refused', async () => {
    FakeSocket.onConnect = (socket) => {
      socket.accept();
      if (socket.kind !== 'audio') return;
      socket.refuse(1008, 'interpretation_settings_not_found', 'Interpretation settings were not found.');
    };
    const { session, capture } = createSession();
    await start(session);
    await flush();

    expect(session.getSnapshot()).toMatchObject({
      phase: 'error',
      error: 'Interpretation settings were not found. (interpretation_settings_not_found)',
      resultConnection: 'closed',
      audioConnection: 'closed',
    });
    expect(endRequests()).toHaveLength(1);
    expect(capture.started).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socketKinds()).toEqual(['result', 'audio']);
  });

  it('fails the start instead of reconnecting when Result closes while /audio is opening', async () => {
    FakeSocket.onConnect = (socket) => {
      if (socket.kind === 'result') socket.accept();
      else FakeSocket.instances[0]!.serverClose(1011, 'internal_error');
    };
    const { session } = createSession();
    await start(session);
    await flush();

    expect(session.getSnapshot()).toMatchObject({
      phase: 'error',
      error: 'The realtime connection closed while starting. (result closed: 1011 internal_error)',
    });
    expect(endRequests()).toHaveLength(1);
    expect(latest().readyState).toBe(FakeSocket.CLOSED);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socketKinds()).toEqual(['result', 'audio']);
  });

  it('fails the start with the message of a system.error that carries no reason', async () => {
    FakeSocket.onConnect = (socket) => {
      if (socket.kind === 'audio') return;
      socket.accept();
      queueMicrotask(() => {
        socket.receive({ type: 'system.error', message: ['Permission denied.'] });
        socket.serverClose(1008);
      });
    };
    const { session, capture } = createSession();
    await start(session);
    await flush();

    expect(session.getSnapshot()).toMatchObject({ phase: 'error', error: 'Permission denied.' });
    expect(endRequests()).toHaveLength(1);
    expect(capture.stopped).toBe(true);
  });

  it('fails the start without POST /end when the server reports the Conversation as gone', async () => {
    FakeSocket.onConnect = (socket) => {
      socket.open();
      socket.refuse(1008, 'conversation_not_found', 'Conversation not found.');
    };
    const { session } = createSession();
    await start(session);
    await flush();

    expect(session.getSnapshot()).toMatchObject({
      phase: 'error',
      error: 'The realtime connection closed while starting. (result closed: 1008 conversation_not_found)',
    });
    expect(endRequests()).toEqual([]);
    expect(socketKinds()).toEqual(['result']);
  });

  it('shows a failed start at once and ends the Conversation in the background', async () => {
    server.settingsStatus = 400;
    server.endStatuses = [503];
    const { session, capture } = createSession();
    await start(session);

    expect(session.getSnapshot()).toMatchObject({ phase: 'error', error: 'Unsupported language.' });
    expect(capture.stopped).toBe(true);
    expect(session.hasPendingEnd()).toBe(true);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(endRequests()).toHaveLength(2);
    expect(session.hasPendingEnd()).toBe(false);
    expect(socketKinds()).toEqual([]);
  });

  it('fails the start when Result does not become ready within 10 seconds', async () => {
    FakeSocket.onConnect = (socket) => socket.open();
    const { session } = createSession();
    const started = start(session);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(session.getSnapshot()).toMatchObject({ phase: 'connecting', resultConnection: 'open' });
    await vi.advanceTimersByTimeAsync(1);
    await started;

    expect(session.getSnapshot()).toMatchObject({
      phase: 'error',
      error: 'The realtime connection closed while starting. (result closed: 1006)',
    });
    expect(endRequests()).toHaveLength(1);
    expect(socketKinds()).toEqual(['result']);
  });
});

describe('RealtimeTranslationSession stop', () => {
  it('sends gate close and idle, waits for the last finals, closes /audio, ends, then closes Result', async () => {
    server.sendsEnded = false;
    const { session, capture, resultSocket, audioSocket } = await startSession(true);
    capture.emit('speech_gate_opened');
    resultSocket.receive(result('transcript.preview', 0, '안녕'));
    timeline = [];

    const stopped = session.stop();
    await flush();
    expect(timeline).toEqual(['audio.status capturing speech_gate_closed', 'audio.status idle']);
    expect(session.getSnapshot().phase).toBe('stopping');

    await vi.advanceTimersByTimeAsync(1_000);
    resultSocket.receive(result('transcript.final', 0, '안녕하세요.'));
    await flush();
    // The transcript is final, but its translation is still missing.
    expect(timeline).toHaveLength(2);
    expect(capture.authorized).toBe(true);
    resultSocket.receive(result('translation.final', 0, 'Hello.', 'en-US'));
    await flush();
    expect(timeline.slice(2)).toEqual(['audio close', `POST ${END_PATH}`]);
    expect(audioSocket.detached).toBe(true);
    // Closing `/audio` disposes its authorization, which stops native capture.
    expect(capture.authorized).toBe(false);
    expect(capture.stopped).toBe(true);
    expect(resultSocket.readyState).toBe(FakeSocket.OPEN);
    expect(session.getSnapshot().phase).toBe('stopping');

    // Results that arrive before conversation.ended are still shown.
    resultSocket.receive(result('transcript.final', 1, '마지막 문장.'));
    resultSocket.receive({ type: 'conversation.ended', data: {} });
    await stopped;
    expect(timeline.slice(4)).toEqual(['result close']);
    expect(session.getSnapshot()).toMatchObject({
      phase: 'ended',
      error: null,
      resultConnection: 'closed',
      audioConnection: 'closed',
    });
    const transcripts = session.getSnapshot().rows.map((row) => row.source?.text);
    expect(transcripts).toEqual(['안녕하세요.', '마지막 문장.']);
    expect(endRequests()).toHaveLength(1);
  });

  it('waits at most 2 seconds for the last final', async () => {
    const { session, resultSocket } = await startSession();
    resultSocket.receive(result('transcript.preview', 0, '안녕'));
    const stopped = session.stop();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(endRequests()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    await stopped;

    expect(endRequests()).toHaveLength(1);
    expect(session.getSnapshot().phase).toBe('ended');
  });

  it('does not wait for finals when the Result socket is not open', async () => {
    const { session, resultSocket } = await startSession();
    resultSocket.receive(result('transcript.preview', 0, '안녕'));
    resultSocket.serverClose(1006);
    await session.stop();

    expect(endRequests()).toHaveLength(1);
    expect(session.getSnapshot()).toMatchObject({ phase: 'ended' });
  });

  it('closes Result 5 seconds after POST /end answers when conversation.ended never arrives', async () => {
    server.sendsEnded = false;
    const { session, resultSocket } = await startSession();
    const stopped = session.stop();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(resultSocket.readyState).toBe(FakeSocket.OPEN);
    expect(session.getSnapshot().phase).toBe('stopping');
    await vi.advanceTimersByTimeAsync(1);
    await stopped;

    expect(resultSocket.readyState).toBe(FakeSocket.CLOSED);
    expect(session.getSnapshot().phase).toBe('ended');
  });

  it('calls POST /end again after 503 and treats 410 as ended', async () => {
    server.endStatuses = [503, 503, 410];
    const { session } = await startSession();
    const stopped = session.stop();
    await flush();
    expect(endRequests()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(endRequests()).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(endRequests()).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(5_000);
    await stopped;

    expect(endRequests()).toHaveLength(3);
    expect(session.getSnapshot()).toMatchObject({ phase: 'ended', error: null });
  });

  it('ends in error when POST /end keeps answering 503', async () => {
    server.endStatuses = [503, 503, 503, 503];
    const { session, resultSocket } = await startSession();
    const stopped = session.stop();
    await vi.advanceTimersByTimeAsync(8_000);
    await stopped;

    expect(endRequests()).toHaveLength(4);
    expect(session.getSnapshot()).toMatchObject({
      phase: 'error',
      error: 'Temporarily unavailable.',
      resultConnection: 'closed',
    });
    expect(resultSocket.readyState).toBe(FakeSocket.CLOSED);
  });

  it('goes straight to POST /end and closes Result when quitting does not wait for results', async () => {
    server.sendsEnded = false;
    const { session, capture, resultSocket } = await startSession(true);
    capture.emit('speech_gate_opened');
    resultSocket.receive(result('transcript.preview', 0, '안녕'));
    timeline = [];

    await session.stop({ waitForResults: false });
    expect(timeline).toEqual([
      'audio.status capturing speech_gate_closed',
      'audio.status idle',
      'audio close',
      `POST ${END_PATH}`,
      'result close',
    ]);
    expect(session.getSnapshot()).toMatchObject({ phase: 'ended', error: null });
  });

  it('shows a failure at once and ends the Conversation in the background', async () => {
    server.endStatuses = [503, 503];
    const { session, audioSocket } = await startSession();
    audioSocket.refuse(1008, 'interpretation_settings_changed', 'Interpretation worker revision conflict.');

    // Before `POST /end` has answered, and it needs two retries here.
    expect(session.getSnapshot()).toMatchObject({
      phase: 'error',
      error: 'Interpretation worker revision conflict. (interpretation_settings_changed)',
      resultConnection: 'closed',
      audioConnection: 'closed',
    });
    expect(session.isActive()).toBe(false);
    expect(session.hasPendingEnd()).toBe(true);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(endRequests()).toHaveLength(3);
    expect(session.hasPendingEnd()).toBe(false);
  });

  it('makes stop() wait for the POST /end of a failure, without doing anything of its own', async () => {
    server.endStatuses = [503];
    const { session, audioSocket } = await startSession();
    audioSocket.refuse(1008, 'interpretation_settings_changed', 'Interpretation worker revision conflict.');
    await flush();
    expect(endRequests()).toHaveLength(1);
    timeline = [];

    let stopped = false;
    void session.stop({ waitForResults: false }).then(() => { stopped = true; });
    await vi.advanceTimersByTimeAsync(999);
    expect(stopped).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(stopped).toBe(true);
    // Only the retry of the failure itself: stop() sent no status and no request.
    expect(timeline).toEqual([`POST ${END_PATH}`]);
    expect(session.getSnapshot()).toMatchObject({
      phase: 'error',
      error: 'Interpretation worker revision conflict. (interpretation_settings_changed)',
    });
  });

  it('keeps the error of the failure when its POST /end fails for good', async () => {
    server.endStatuses = [503, 503, 503, 503];
    const { session, audioSocket } = await startSession();
    audioSocket.refuse(1008, 'interpretation_settings_changed', 'Interpretation worker revision conflict.');
    const stopped = session.stop();
    await vi.advanceTimersByTimeAsync(8_000);
    await stopped;

    expect(endRequests()).toHaveLength(4);
    expect(session.hasPendingEnd()).toBe(false);
    expect(session.getSnapshot()).toMatchObject({
      phase: 'error',
      error: 'Interpretation worker revision conflict. (interpretation_settings_changed)',
    });
  });
});
