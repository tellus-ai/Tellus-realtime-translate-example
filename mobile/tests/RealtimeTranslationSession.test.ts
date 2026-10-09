import type { MicrophoneRecorder } from '../src/audio/NativeMicrophone';
import type { AudioChunk } from '@tellus-ai/audio-sdk/react-native';
import { RealtimeTranslationSession } from '../src/realtime/RealtimeTranslationSession';

const endpoints = { httpBaseUrl: 'https://example.test', websocketBaseUrl: 'wss://example.test', appOrigin: 'https://app.example.test' };
const END_PATH = '/conversations/conversation-1/end';
const SETTINGS_PATH = '/conversations/conversation-1/interpretation-settings';
const NO_ANSWER = 'no answer';
const ENDED_BY_SERVER = { phase: 'ended', error: null };

/** What the client sent, closed, and requested, in the order it happened. */
let timeline: string[];

/** The REST side of the server. Tests change these fields to script its answers. */
const server = {
  requests: [] as string[],
  /** Statuses for the next `POST /end` calls; 200 once the list is empty. */
  endStatuses: [] as Array<number | typeof NO_ANSWER>,
  /** `POST /end` is answered only when this resolves. */
  endGate: Promise.resolve(),
  /** Whether a successful `POST /end` is followed by `conversation.ended` and 1000 on Result. */
  sendsEnded: true,
  settingsStatus: 200,
};

function gate(): { opened: Promise<void>; open: () => void } {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open };
}

class FakeMicrophone implements MicrophoneRecorder {
  capturing = false;
  startError: Error | null = null;
  resumeError: Error | null = null;
  /** A start and a pause finish only when these resolve. */
  startGate: Promise<void> = Promise.resolve();
  authorizationGate: Promise<void> = Promise.resolve();
  pauseGate: Promise<void> = Promise.resolve();
  private onFrame: ((frame: AudioChunk) => void) | null = null;
  private onError: ((error: Error) => void) | null = null;

  private vad = false;
  private gateOpen = false;
  async prepare(vad: boolean): Promise<void> { this.vad = vad; }
  async authorize(socket: WebSocket): Promise<void> {
    if (socket.readyState !== WebSocket.OPEN) await new Promise<void>(resolve => {
      const opened = socket.onopen;
      socket.onopen = event => { opened?.call(socket, event); resolve(); };
    });
    await this.authorizationGate;
    this.gateOpen = false;
  }
  releaseAuthorization(): void { this.capturing = false; }
  async start(onFrame: (frame: AudioChunk) => void, onError: (error: Error) => void): Promise<void> {
    await this.startGate;
    if (this.startError) throw this.startError;
    this.onFrame = onFrame;
    this.onError = onError;
    this.capturing = true;
  }
  async pause(): Promise<void> {
    this.capturing = false;
    this.gateOpen = false;
    await this.pauseGate;
  }
  async resume(): Promise<void> {
    if (this.resumeError) throw this.resumeError;
    this.capturing = true;
  }
  async stop(): Promise<void> {
    this.onFrame = null;
    this.capturing = false;
  }
  emit(): void {
    const event = this.vad && !this.gateOpen ? 'speech_gate_opened' : undefined;
    this.gateOpen = this.vad;
    this.onFrame?.({ data: { microphone: new Uint8Array(30) }, trackSource: 'microphone', codec: 'opus',
      sampleRate: 16000, sampleCount: 320, validSampleCount: 320, durationMs: 20, sample: 0, timestamp: 0, rms: 0,
      gateEvent: event });
  }
  /** The native recorder reports an error. */
  fail(error: Error): void {
    this.onError?.(error);
  }
}

class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];
  /** What the server does with a new connection. Tests replace it to refuse or stall one. */
  static onConnect: (socket: FakeSocket) => void;

  readonly kind: 'result' | 'audio';
  readonly sent: Array<string | ArrayBuffer> = [];
  readyState = FakeSocket.CONNECTING;
  binaryType = 'blob';
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code?: number; reason?: string }) => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;

  constructor(readonly url: string, _protocols: null, readonly options: { headers: Record<string, string> }) {
    this.kind = url.includes('/audio?') ? 'audio' : 'result';
    FakeSocket.instances.push(this);
    queueMicrotask(() => FakeSocket.onConnect(this));
  }

  /** The server accepts the connection. Result then sends its ready message. */
  accept(): void {
    this.open();
    if (this.kind === 'result') this.receive({ type: 'participants.snapshot', data: {} });
  }
  open(): void {
    this.readyState = FakeSocket.OPEN;
    this.onopen?.();
  }
  receive(message: object): void {
    this.onmessage?.({ data: JSON.stringify(message) });
  }
  /** A close that the client did not start. */
  serverClose(code: number, reason = ''): void {
    this.closeWith({ code, reason });
  }
  /** The same, with the close event exactly as React Native delivered it. */
  closeWith(event: { code?: number; reason?: string }): void {
    this.readyState = FakeSocket.CLOSED;
    this.onclose?.(event);
  }
  send(data: string | ArrayBuffer): void {
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
}

function describeStatus(raw: string): string {
  const status = JSON.parse(raw) as { mic: { state: string }; vad: { event?: string } };
  return ['audio.status', status.mic.state, status.vad.event].filter(Boolean).join(' ');
}

function reply(status: number, data: unknown = {}, message = 'ok'): Response {
  const body = JSON.stringify({ statusCode: String(status), message: [message], data });
  return { ok: status < 300, status, text: async () => body } as Response;
}

async function fakeFetch(url: string, init: RequestInit): Promise<Response> {
  const path = url.replace(endpoints.httpBaseUrl, '').split('?')[0];
  server.requests.push(`${init.method} ${path}`);
  timeline.push(`${init.method} ${path}`);
  if (path === '/conversations') return reply(200, { conversation_id: 'conversation-1' });
  if (path === SETTINGS_PATH && server.settingsStatus !== 200) return reply(server.settingsStatus, null, 'Permission denied.');
  if (path === END_PATH) {
    const status = server.endStatuses.shift() ?? 200;
    // Like fetch, a request that is never answered ends only when its signal aborts it.
    if (status === NO_ANSWER) return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('Aborted'))));
    await server.endGate;
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
    data: { conversation_id: 'conversation-1', event_type: eventType, order_seq: orderSeq, text, source_language: 'ko-KR', target_language: targetLanguage },
  };
}

function createSession() {
  const microphone = new FakeMicrophone();
  const session = new RealtimeTranslationSession(endpoints, microphone, 'token');
  return { session, microphone };
}

async function startSession(clientVad = false) {
  const created = createSession();
  await created.session.start({ sourceLanguage: 'ko-KR', targetLanguage: 'en-US', clientVad });
  const [resultSocket, audioSocket] = FakeSocket.instances;
  return { ...created, resultSocket: resultSocket!, audioSocket: audioSocket! };
}

/** Runs everything that is ready to run without moving the clock. */
const flush = () => jest.advanceTimersByTimeAsync(0);
const endRequests = () => server.requests.filter((request) => request === `POST ${END_PATH}`);
const socketKinds = () => FakeSocket.instances.map((socket) => socket.kind);
const latest = () => FakeSocket.instances.at(-1)!;

/** Checks that the next socket is opened exactly `delayMs` from now, and returns it. */
async function reopenedAfter(delayMs: number): Promise<FakeSocket> {
  const count = FakeSocket.instances.length;
  await jest.advanceTimersByTimeAsync(delayMs - 1);
  expect(FakeSocket.instances).toHaveLength(count);
  await jest.advanceTimersByTimeAsync(1);
  expect(FakeSocket.instances.length).toBeGreaterThan(count);
  return latest();
}

const originalFetch = globalThis.fetch;
const originalWebSocket = globalThis.WebSocket;

beforeEach(() => {
  // The fake socket connects in a microtask, like a promise, not on the fake clock.
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask'] });
  timeline = [];
  Object.assign(server, { requests: [], endStatuses: [], endGate: Promise.resolve(), sendsEnded: true, settingsStatus: 200 });
  FakeSocket.instances = [];
  FakeSocket.onConnect = (socket) => socket.accept();
  globalThis.fetch = fakeFetch as typeof fetch;
  globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;
});

afterEach(() => {
  jest.useRealTimers();
  globalThis.fetch = originalFetch;
  globalThis.WebSocket = originalWebSocket;
});

describe('RealtimeTranslationSession when the Conversation ends on the server', () => {
  it.each(['result', 'audio'] as const)('shows it as ended, without POST /end, when %s closes with 1000', async (kind) => {
    const { session, microphone, resultSocket, audioSocket } = await startSession();
    (kind === 'result' ? resultSocket : audioSocket).serverClose(1000, 'conversation_ended');
    await flush();

    expect(session.getSnapshot()).toMatchObject({ ...ENDED_BY_SERVER, resultConnection: 'closed', audioConnection: 'closed' });
    expect(endRequests()).toEqual([]);
    expect(microphone.capturing).toBe(false);
    expect([resultSocket.readyState, audioSocket.readyState]).toEqual([FakeSocket.CLOSED, FakeSocket.CLOSED]);

    await jest.advanceTimersByTimeAsync(60_000);
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

describe('RealtimeTranslationSession when a Result message is not valid', () => {
  it('shows the problem and goes on', async () => {
    const { session, microphone, resultSocket, audioSocket } = await startSession();
    resultSocket.receive({ type: 'result', data: { event_type: 'transcript.final' } });
    expect(session.getSnapshot()).toMatchObject({
      phase: 'recording',
      error: 'Invalid Result WebSocket payload.',
      resultConnection: 'open',
      audioConnection: 'open',
    });

    resultSocket.receive(result('transcript.final', 0, '안녕하세요.'));
    microphone.emit();
    await flush();
    expect(session.getSnapshot().rows).toHaveLength(1);
    expect(audioSocket.sent.at(-1)).toBeInstanceOf(ArrayBuffer);
    expect(endRequests()).toEqual([]);
  });
});

describe('RealtimeTranslationSession when the server refuses a socket', () => {
  it('stops with the server message and calls POST /end after 1008 interpretation_settings_changed', async () => {
    const { session, microphone, audioSocket } = await startSession();
    audioSocket.receive(systemError(1008, 'interpretation_settings_changed', 'Interpretation worker revision conflict.'));
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
    expect(microphone.capturing).toBe(false);

    await jest.advanceTimersByTimeAsync(60_000);
    expect(socketKinds()).toEqual(['result', 'audio']);
  });

  it('stops but leaves the Conversation open after 1008 audio_connection_replaced', async () => {
    const { session, audioSocket } = await startSession();
    audioSocket.receive(systemError(1008, 'audio_connection_replaced', 'Audio connection was replaced.'));
    audioSocket.serverClose(1008, 'audio_connection_replaced');
    // Neither a stop() during the cleanup nor one after it may end the Conversation: unmounting
    // the component calls stop().
    const stoppedDuringCleanup = session.stop();
    await flush();
    await stoppedDuringCleanup;

    expect(session.getSnapshot()).toMatchObject({
      phase: 'error',
      error: 'Another device or tab took over the audio of this Conversation.',
    });
    await session.stop();
    expect(session.getSnapshot().phase).toBe('error');
    expect(endRequests()).toEqual([]);
  });
});

describe('RealtimeTranslationSession when POST /end is slow after a failure', () => {
  it('shows the error before POST /end answers, and stop() waits for that POST /end', async () => {
    const { session, audioSocket } = await startSession();
    const held = gate();
    server.endGate = held.opened;
    audioSocket.serverClose(1008, 'interpretation_settings_changed');
    await flush();
    expect(session.getSnapshot()).toMatchObject({
      phase: 'error',
      error: 'The server refused the connection. (interpretation_settings_changed)',
      resultConnection: 'closed',
      audioConnection: 'closed',
    });
    expect(endRequests()).toHaveLength(1);

    let returned = false;
    const stopping = session.stop().then(() => { returned = true; });
    await flush();
    expect(returned).toBe(false);
    held.open();
    await stopping;
    // stop() did nothing of its own: the phase stays, and no second POST /end was sent.
    expect(session.getSnapshot().phase).toBe('error');
    expect(endRequests()).toHaveLength(1);
  });

  it('shows a start failure before POST /end answers', async () => {
    const held = gate();
    server.endGate = held.opened;
    server.settingsStatus = 403;
    const { session } = createSession();
    await session.start({ sourceLanguage: 'ko-KR', targetLanguage: 'en-US', clientVad: false });
    await flush();
    expect(session.getSnapshot()).toMatchObject({ phase: 'error', error: 'Permission denied.' });
    expect(endRequests()).toHaveLength(1);
    expect(FakeSocket.instances).toHaveLength(0);

    // A new session can start while the old Conversation is still being ended.
    server.settingsStatus = 200;
    await session.start({ sourceLanguage: 'ko-KR', targetLanguage: 'en-US', clientVad: false });
    expect(session.getSnapshot()).toMatchObject({ phase: 'recording', error: null });
    held.open();
    await flush();
    expect(endRequests()).toHaveLength(1);
  });

  it('gives up POST /end after its retries and stays in error', async () => {
    const { session, audioSocket } = await startSession();
    server.endStatuses = [503, 503, 503, 503];
    audioSocket.serverClose(1008, 'interpretation_settings_changed');
    await flush();
    expect(session.getSnapshot().phase).toBe('error');

    const stopping = session.stop();
    await jest.advanceTimersByTimeAsync(8_000);
    await stopping;
    expect(endRequests()).toHaveLength(4);
    expect(session.getSnapshot().phase).toBe('error');
  });
});

describe('RealtimeTranslationSession reconnects', () => {
  it('reopens only /audio, after retry_after_ms, with a fresh sample cursor', async () => {
    const { session, microphone, resultSocket, audioSocket } = await startSession(true);
    microphone.emit();
    microphone.emit();
    await flush();

    const reason = 'audio_pipeline_activation_rate_limited';
    audioSocket.receive(systemError(1013, reason, 'Audio pipeline reconnect rate limit exceeded.', { retry_after_ms: 3_000 }));
    audioSocket.serverClose(1013, reason);
    await flush();
    expect(session.getSnapshot()).toMatchObject({
      phase: 'reconnecting',
      error: null,
      resultConnection: 'open',
      audioConnection: 'closed',
      vad: { gate: 'closed' },
    });
    expect(microphone.capturing).toBe(false);

    const reopened = await reopenedAfter(3_000);
    expect(socketKinds()).toEqual(['result', 'audio', 'audio']);
    expect(resultSocket.readyState).toBe(FakeSocket.OPEN);
    expect(resultSocket.detached).toBe(false);
    expect(session.getSnapshot()).toMatchObject({ phase: 'recording', audioConnection: 'open' });
    expect(microphone.capturing).toBe(true);

    microphone.emit();
    await flush();
    // Status first, then the gate event of the reset VAD, both counted from sample 0 again.
    const [status, gateOpened, frame] = reopened.sent;
    expect(JSON.parse(status as string)).toMatchObject({ boundary_sample: 0, mic: { state: 'capturing' } });
    expect(JSON.parse(gateOpened as string)).toMatchObject({ boundary_sample: 0, vad: { event: 'speech_gate_opened' } });
    expect(frame).toBeInstanceOf(ArrayBuffer);
    // status_seq keeps counting through the Conversation.
    expect(JSON.parse(status as string).status_seq).toBeGreaterThan(
      JSON.parse(audioSocket.sent.filter((item) => typeof item === 'string').at(-1) as string).status_seq,
    );

    // The rate limit belonged to the old socket: the next close uses the plain backoff.
    reopened.serverClose(1006);
    await reopenedAfter(2_000);
  });

  it('keeps sending audio while only Result reconnects, and shows only later results', async () => {
    const { session, microphone, resultSocket, audioSocket } = await startSession();
    resultSocket.receive(result('transcript.final', 0, '안녕하세요.'));
    resultSocket.serverClose(1013, 'result_send_failed');
    await flush();
    expect(session.getSnapshot()).toMatchObject({
      phase: 'recording',
      error: null,
      resultConnection: 'closed',
      audioConnection: 'open',
    });
    expect(microphone.capturing).toBe(true);

    microphone.emit();
    await flush();
    expect(audioSocket.sent.at(-1)).toBeInstanceOf(ArrayBuffer);

    const requestsBeforeReconnect = [...server.requests];
    const reopened = await reopenedAfter(1_000);
    expect(socketKinds()).toEqual(['result', 'audio', 'result']);
    expect(audioSocket.readyState).toBe(FakeSocket.OPEN);
    expect(audioSocket.detached).toBe(false);
    expect(session.getSnapshot()).toMatchObject({ phase: 'recording', resultConnection: 'open' });

    // What the server sent during the gap is not recovered: the earlier row stays as it was.
    reopened.receive(result('transcript.final', 2, '다시 연결됐습니다.'));
    await jest.advanceTimersByTimeAsync(10_000);
    expect(session.getSnapshot().rows).toMatchObject([
      { orderSeq: 0, source: { text: '안녕하세요.', isFinal: true }, translations: {} },
      { orderSeq: 2, source: { text: '다시 연결됐습니다.', isFinal: true } },
    ]);
    expect(server.requests).toEqual(requestsBeforeReconnect);

    microphone.emit();
    await flush();
    // One status when recording started, then nothing but audio: the sample cursor went on.
    expect(audioSocket.sent.filter((item) => item instanceof ArrayBuffer)).toHaveLength(2);
    expect(audioSocket.sent.filter((item) => typeof item === 'string')).toHaveLength(1);
  });

  it('keeps the VAD gate and the sample cursor while only Result reconnects', async () => {
    const { session, microphone, resultSocket, audioSocket } = await startSession(true);
    microphone.emit();
    await flush();
    resultSocket.serverClose(1006);
    await reopenedAfter(1_000);
    microphone.emit();
    await flush();

    expect(session.getSnapshot()).toMatchObject({ phase: 'recording', vad: { gate: 'open' } });
    // The gate opened once, on the first frame, and the second frame follows it without a new status.
    expect(audioSocket.sent.map((item) => (typeof item === 'string' ? describeStatus(item) : 'audio frame'))).toEqual([
      'audio.status capturing',
      'audio.status capturing speech_gate_opened',
      'audio frame',
      'audio frame',
    ]);
  });

  it('finishes a pause that is waiting for the microphone while Result reconnects', async () => {
    const { session, microphone, resultSocket, audioSocket } = await startSession();
    const held = gate();
    microphone.pauseGate = held.opened;
    const paused = session.pause();
    resultSocket.serverClose(1006);
    await reopenedAfter(1_000);
    expect(session.getSnapshot()).toMatchObject({ phase: 'recording', resultConnection: 'open' });

    held.open();
    await paused;
    expect(session.getSnapshot().phase).toBe('paused');
    expect(describeStatus(audioSocket.sent.at(-1) as string)).toBe('audio.status paused');
  });

  it('still ends the session on a microphone error after a reconnect', async () => {
    const { session, microphone, resultSocket } = await startSession();
    resultSocket.serverClose(1006);
    await reopenedAfter(1_000);
    microphone.fail(new Error('The recorder stopped.'));
    await flush();

    expect(session.getSnapshot()).toMatchObject({ phase: 'error', error: 'The recorder stopped.' });
    expect(endRequests()).toHaveLength(1);
  });

  it('opens Result first when both sockets closed, and /audio only after Result is ready', async () => {
    const { session, resultSocket, audioSocket } = await startSession();
    FakeSocket.onConnect = () => {};
    resultSocket.serverClose(1006);
    audioSocket.serverClose(1006);
    await flush();
    expect(session.getSnapshot()).toMatchObject({ phase: 'reconnecting', resultConnection: 'closed', audioConnection: 'closed' });

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
    await jest.advanceTimersByTimeAsync(600);
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

    const reason = 'audio_pipeline_activation_rate_limited';
    audioSocket.receive(systemError(1013, reason, 'Audio pipeline reconnect rate limit exceeded.', { retry_after_ms: 3_000 }));
    audioSocket.serverClose(1013, reason);
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
    await jest.advanceTimersByTimeAsync(2_000);
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
    const { session, microphone, audioSocket } = await startSession();
    const reason = 'audio_pipeline_activation_rate_limited';
    FakeSocket.onConnect = (socket) => {
      socket.accept();
      socket.receive(systemError(1013, reason, 'Audio pipeline reconnect rate limit exceeded.', { retry_after_ms: 800 }));
      socket.serverClose(1013, reason);
    };
    audioSocket.serverClose(1006);
    await reopenedAfter(1_000);
    expect(session.getSnapshot()).toMatchObject({
      phase: 'reconnecting',
      error: null,
      audioConnection: 'closed',
    });
    expect(microphone.capturing).toBe(false);

    FakeSocket.onConnect = (socket) => socket.accept();
    await reopenedAfter(2_000);
    expect(session.getSnapshot()).toMatchObject({ phase: 'recording' });
    expect(microphone.capturing).toBe(true);
  });

  it('keeps reconnecting when the new Result socket becomes ready and closes in the same tick', async () => {
    const { session, microphone, resultSocket } = await startSession();
    FakeSocket.onConnect = (socket) => {
      socket.accept();
      socket.serverClose(1013, 'result_send_failed');
    };
    resultSocket.serverClose(1006);
    await reopenedAfter(1_000);
    expect(session.getSnapshot()).toMatchObject({
      phase: 'recording',
      error: null,
      resultConnection: 'closed',
      audioConnection: 'open',
    });
    expect(microphone.capturing).toBe(true);

    FakeSocket.onConnect = (socket) => socket.accept();
    await reopenedAfter(2_000);
    expect(socketKinds()).toEqual(['result', 'audio', 'result', 'result']);
    expect(session.getSnapshot()).toMatchObject({ phase: 'recording', resultConnection: 'open' });
  });

  it('ends the session when the microphone cannot be resumed after reconnecting', async () => {
    const { session, microphone, audioSocket } = await startSession();
    microphone.resumeError = new Error('Unable to restart the microphone stream.');
    audioSocket.serverClose(1006);
    await reopenedAfter(1_000);

    expect(session.getSnapshot()).toMatchObject({ phase: 'error', error: 'Unable to restart the microphone stream.' });
    expect(endRequests()).toHaveLength(1);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(socketKinds()).toEqual(['result', 'audio', 'audio']);
  });

  it('reopens /audio only after the microphone has paused', async () => {
    const { microphone, audioSocket } = await startSession(true);
    const held = gate();
    microphone.pauseGate = held.opened;
    audioSocket.serverClose(1006);
    await jest.advanceTimersByTimeAsync(1_000);
    expect(socketKinds()).toEqual(['result', 'audio']);

    held.open();
    await flush();
    expect(socketKinds()).toEqual(['result', 'audio', 'audio']);
  });

  it('stays paused when /audio reconnects during a pause', async () => {
    const { session, microphone, audioSocket } = await startSession();
    await session.pause();
    audioSocket.serverClose(1006);
    await flush();
    expect(session.getSnapshot().phase).toBe('reconnecting');

    const reopened = await reopenedAfter(1_000);
    expect(session.getSnapshot()).toMatchObject({ phase: 'paused', audioConnection: 'open' });
    expect(microphone.capturing).toBe(false);
    expect(reopened.sent.map((item) => describeStatus(item as string))).toEqual(['audio.status paused']);
  });

  it('comes back paused when pause() arrives while /audio is reconnecting', async () => {
    const { session, microphone, audioSocket } = await startSession();
    audioSocket.serverClose(1006);
    await flush();
    expect(session.getSnapshot().phase).toBe('reconnecting');
    await session.pause();
    expect(session.getSnapshot().phase).toBe('reconnecting');

    const reopened = await reopenedAfter(1_000);
    expect(session.getSnapshot()).toMatchObject({ phase: 'paused', error: null, audioConnection: 'open' });
    expect(microphone.capturing).toBe(false);
    expect(reopened.sent.map((item) => describeStatus(item as string))).toEqual(['audio.status paused']);

    // The user resumes as after any other pause.
    await session.resume();
    expect(session.getSnapshot().phase).toBe('recording');
    expect(microphone.capturing).toBe(true);
    expect(describeStatus(reopened.sent.at(-1) as string)).toBe('audio.status capturing');
  });

  it('backs off further when a reopened socket closes again, and starts over after 30 stable seconds', async () => {
    const { audioSocket } = await startSession();
    audioSocket.serverClose(1011);
    let reopened = await reopenedAfter(1_000);

    reopened.serverClose(1011);
    reopened = await reopenedAfter(2_000);

    await jest.advanceTimersByTimeAsync(29_999);
    reopened.serverClose(1011);
    reopened = await reopenedAfter(5_000);

    await jest.advanceTimersByTimeAsync(30_000);
    reopened.serverClose(1011);
    await reopenedAfter(1_000);
  });

  it('gives up an attempt that does not open within 10 seconds and ignores that socket afterwards', async () => {
    const { session, audioSocket } = await startSession();
    FakeSocket.onConnect = () => {};
    audioSocket.serverClose(1006);
    const stalled = await reopenedAfter(1_000);

    await jest.advanceTimersByTimeAsync(10_000);
    expect(stalled.readyState).toBe(FakeSocket.CLOSED);
    expect(stalled.detached).toBe(true);
    expect(session.getSnapshot()).toMatchObject({ phase: 'reconnecting', audioConnection: 'closed' });

    FakeSocket.onConnect = (socket) => socket.accept();
    await reopenedAfter(2_000);
    stalled.serverClose(1008, 'audio_pipeline_fenced');
    await flush();
    expect(session.getSnapshot()).toMatchObject({ phase: 'recording', error: null, audioConnection: 'open' });
    expect(socketKinds()).toEqual(['result', 'audio', 'audio', 'audio']);
  });

  it('cancels a pending reconnect on Stop', async () => {
    server.sendsEnded = false;
    const { session, audioSocket } = await startSession();
    audioSocket.serverClose(1006);
    const stopped = session.stop();
    await flush();
    expect(session.getSnapshot()).toMatchObject({ phase: 'stopping' });
    await jest.advanceTimersByTimeAsync(5_000);
    await stopped;

    expect(session.getSnapshot()).toMatchObject({ phase: 'ended', error: null });
    await jest.advanceTimersByTimeAsync(60_000);
    expect(socketKinds()).toEqual(['result', 'audio']);
  });
});

describe('RealtimeTranslationSession on React Native sockets', () => {
  it('opens both sockets with the Origin header', async () => {
    await startSession();
    expect(FakeSocket.instances.map((socket) => socket.options)).toEqual([
      { headers: { Origin: 'https://app.example.test' } },
      { headers: { Origin: 'https://app.example.test' } },
    ]);
  });

  const closesWithoutCode: Array<[string, { code?: number; reason?: string }]> = [
    ['neither code nor reason', {}],
    ['code 0, which is how React Native 0.83 reports a missing code', { code: 0, reason: '' }],
  ];

  it.each(closesWithoutCode)('reconnects after a close event with %s', async (_case, event) => {
    const { session, microphone, audioSocket } = await startSession();
    audioSocket.closeWith(event);
    await flush();
    expect(session.getSnapshot()).toMatchObject({ phase: 'reconnecting', error: null, audioConnection: 'closed' });

    await reopenedAfter(1_000);
    expect(socketKinds()).toEqual(['result', 'audio', 'audio']);
    expect(session.getSnapshot()).toMatchObject({ phase: 'recording', error: null, audioConnection: 'open' });
    expect(microphone.capturing).toBe(true);
  });

  it.each(closesWithoutCode)('reports a close event with %s as 1006 when it fails the start', async (_case, event) => {
    FakeSocket.onConnect = (socket) => socket.closeWith(event);
    const { session } = createSession();
    await session.start({ sourceLanguage: 'ko-KR', targetLanguage: 'en-US', clientVad: false });
    await flush();

    expect(session.getSnapshot()).toMatchObject({
      phase: 'error',
      error: 'The realtime connection closed while starting. (result closed: 1006)',
    });
    expect(endRequests()).toHaveLength(1);
  });

  it('reads the reason from system.error when the close event has no reason', async () => {
    const { session, audioSocket } = await startSession();
    audioSocket.receive(systemError(1008, 'audio_connection_replaced', 'Audio connection was replaced.'));
    audioSocket.closeWith({ code: 1008 });
    await flush();

    expect(session.getSnapshot()).toMatchObject({
      phase: 'error',
      error: 'Another device or tab took over the audio of this Conversation.',
    });
    expect(endRequests()).toEqual([]);
  });
});

describe('RealtimeTranslationSession while starting', () => {
  const start = (session: RealtimeTranslationSession) =>
    session.start({ sourceLanguage: 'ko-KR', targetLanguage: 'en-US', clientVad: false });

  it('fails the start with the server message when /audio is accepted and then refused', async () => {
    FakeSocket.onConnect = (socket) => {
      socket.accept();
      if (socket.kind !== 'audio') return;
      socket.receive(systemError(1008, 'interpretation_settings_not_found', 'Interpretation settings were not found.'));
      socket.serverClose(1008, 'interpretation_settings_not_found');
    };
    const { session, microphone } = createSession();
    await start(session);
    await flush();

    expect(session.getSnapshot()).toMatchObject({
      phase: 'error',
      error: 'Interpretation settings were not found. (interpretation_settings_not_found)',
      resultConnection: 'closed',
      audioConnection: 'closed',
    });
    expect(endRequests()).toHaveLength(1);
    expect(microphone.capturing).toBe(false);
    await jest.advanceTimersByTimeAsync(60_000);
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
    await jest.advanceTimersByTimeAsync(60_000);
    expect(socketKinds()).toEqual(['result', 'audio']);
  });

  it('fails the start without POST /end when the server reports the Conversation as gone', async () => {
    FakeSocket.onConnect = (socket) => {
      socket.open();
      socket.receive(systemError(1008, 'conversation_not_found', 'Conversation not found.'));
      socket.serverClose(1008, 'conversation_not_found');
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

  it('fails the start when Result does not become ready within 10 seconds', async () => {
    FakeSocket.onConnect = (socket) => socket.open();
    const { session } = createSession();
    const started = start(session);
    await jest.advanceTimersByTimeAsync(9_999);
    expect(session.getSnapshot()).toMatchObject({ phase: 'connecting', resultConnection: 'open' });
    await jest.advanceTimersByTimeAsync(1);
    await started;

    expect(session.getSnapshot()).toMatchObject({
      phase: 'error',
      error: 'The realtime connection closed while starting. (result closed: 1006)',
    });
    expect(endRequests()).toHaveLength(1);
    expect(socketKinds()).toEqual(['result']);
  });
});

describe('RealtimeTranslationSession while the microphone starts', () => {
  type Started = { session: RealtimeTranslationSession; resultSocket: FakeSocket; audioSocket: FakeSocket };

  /** The session is `recording` and `microphone.start()` has not returned yet. */
  async function startWithSlowMicrophone() {
    const { session, microphone } = createSession();
    const starting = gate();
    microphone.startGate = starting.opened;
    const started = session.start({ sourceLanguage: 'ko-KR', targetLanguage: 'en-US', clientVad: false });
    await flush();
    expect(session.getSnapshot().phase).toBe('recording');
    const [resultSocket, audioSocket] = FakeSocket.instances;
    return { session, microphone, resultSocket: resultSocket!, audioSocket: audioSocket!, finishStart: async () => { starting.open(); await started; } };
  }

  it.each<[string, (started: Started) => Promise<void>, string]>([
    ['the server refused /audio with 1008', async ({ audioSocket }) => {
      audioSocket.receive(systemError(1008, 'interpretation_settings_changed', 'Interpretation worker revision conflict.'));
      audioSocket.serverClose(1008, 'interpretation_settings_changed');
      await flush();
    }, 'error'],
    ['Stop', ({ session }) => session.stop(), 'ended'],
    ['conversation.ended', async ({ resultSocket }) => {
      resultSocket.receive({ type: 'conversation.ended', data: {} });
      await flush();
    }, 'ended'],
  ])('stops the microphone when it finishes starting after %s', async (_case, end, phase) => {
    const { microphone, finishStart, ...started } = await startWithSlowMicrophone();
    await end(started);
    expect(started.session.getSnapshot().phase).toBe(phase);

    await finishStart();
    expect(microphone.capturing).toBe(false);
    expect(started.session.getSnapshot().phase).toBe(phase);
  });

  it('pauses the microphone when it finishes starting after Pause', async () => {
    const { session, microphone, finishStart } = await startWithSlowMicrophone();
    await session.pause();
    expect(session.getSnapshot().phase).toBe('paused');

    await finishStart();
    expect(microphone.capturing).toBe(false);
    await session.resume();
    expect(session.getSnapshot().phase).toBe('recording');
    expect(microphone.capturing).toBe(true);
  });

  // The session is already `recording` here, so a close reconnects instead of failing the start.
  it('closes the session when the microphone fails to start while /audio is reconnecting', async () => {
    const { session, microphone } = createSession();
    const starting = gate();
    microphone.startGate = starting.opened;
    microphone.startError = new Error('Unable to start microphone recording.');
    const started = session.start({ sourceLanguage: 'ko-KR', targetLanguage: 'en-US', clientVad: false });
    await flush();
    expect(session.getSnapshot().phase).toBe('recording');

    // The reconnect attempt is waiting for the microphone to pause when the start fails.
    const pausing = gate();
    microphone.pauseGate = pausing.opened;
    latest().serverClose(1006);
    await jest.advanceTimersByTimeAsync(1_000);
    starting.open();
    await flush();
    pausing.open();
    await started;
    await jest.advanceTimersByTimeAsync(60_000);

    expect(session.getSnapshot()).toMatchObject({
      phase: 'error',
      error: 'Unable to start microphone recording.',
      resultConnection: 'closed',
      audioConnection: 'closed',
    });
    expect(endRequests()).toHaveLength(1);
    expect(socketKinds()).toEqual(['result', 'audio']);
  });

  it('reconnects /audio when it closes while the microphone is starting', async () => {
    const { session, microphone } = createSession();
    const starting = gate();
    microphone.startGate = starting.opened;
    const started = session.start({ sourceLanguage: 'ko-KR', targetLanguage: 'en-US', clientVad: false });
    await flush();
    latest().serverClose(1006);
    await flush();
    expect(session.getSnapshot().phase).toBe('reconnecting');

    starting.open();
    await started;
    await reopenedAfter(1_000);
    expect(session.getSnapshot()).toMatchObject({ phase: 'recording', error: null, audioConnection: 'open' });
    expect(microphone.capturing).toBe(true);
    expect(endRequests()).toEqual([]);
  });
});

describe('RealtimeTranslationSession stop', () => {
  it('sends gate close and idle, waits for the last finals, closes /audio, ends, then closes Result', async () => {
    server.sendsEnded = false;
    const { session, microphone, resultSocket, audioSocket } = await startSession(true);
    microphone.emit();
    await flush();
    resultSocket.receive(result('transcript.preview', 0, '안녕'));
    timeline = [];

    const stopped = session.stop();
    await flush();
    expect(timeline).toEqual(['audio.status capturing speech_gate_closed', 'audio.status idle']);
    expect(session.getSnapshot().phase).toBe('stopping');

    await jest.advanceTimersByTimeAsync(1_000);
    resultSocket.receive(result('transcript.final', 0, '안녕하세요.'));
    await flush();
    // The transcript is final, but its translation is still missing.
    expect(timeline).toHaveLength(2);
    resultSocket.receive(result('translation.final', 0, 'Hello.', 'en-US'));
    await flush();
    expect(timeline.slice(2)).toEqual(['audio close', `POST ${END_PATH}`]);
    expect(audioSocket.detached).toBe(true);
    expect(resultSocket.readyState).toBe(FakeSocket.OPEN);
    expect(session.getSnapshot().phase).toBe('stopping');

    // Results that arrive before conversation.ended are still shown.
    resultSocket.receive(result('transcript.final', 1, '마지막 문장.'));
    resultSocket.receive({ type: 'conversation.ended', data: {} });
    await stopped;
    expect(timeline.slice(4)).toEqual(['result close']);
    expect(session.getSnapshot()).toMatchObject({ phase: 'ended', error: null, resultConnection: 'closed', audioConnection: 'closed' });
    expect(session.getSnapshot().rows.map((row) => row.source?.text)).toEqual(['안녕하세요.', '마지막 문장.']);
    expect(endRequests()).toHaveLength(1);
  });

  it('waits at most 2 seconds for the last final', async () => {
    const { session, resultSocket } = await startSession();
    resultSocket.receive(result('transcript.preview', 0, '안녕'));
    const stopped = session.stop();
    await jest.advanceTimersByTimeAsync(1_999);
    expect(endRequests()).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(1);
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
    await jest.advanceTimersByTimeAsync(4_999);
    expect(resultSocket.readyState).toBe(FakeSocket.OPEN);
    expect(session.getSnapshot().phase).toBe('stopping');
    await jest.advanceTimersByTimeAsync(1);
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
    await jest.advanceTimersByTimeAsync(1_000);
    expect(endRequests()).toHaveLength(2);
    await jest.advanceTimersByTimeAsync(2_000);
    expect(endRequests()).toHaveLength(3);
    await jest.advanceTimersByTimeAsync(5_000);
    await stopped;

    expect(endRequests()).toHaveLength(3);
    expect(session.getSnapshot()).toMatchObject({ phase: 'ended', error: null });
  });

  it('ends the Conversation when stop() arrives while the sockets are opening', async () => {
    FakeSocket.onConnect = () => {};
    const { session } = createSession();
    const started = session.start({ sourceLanguage: 'ko-KR', targetLanguage: 'en-US', clientVad: false });
    await flush();
    expect(session.getSnapshot()).toMatchObject({ phase: 'connecting', resultConnection: 'connecting' });

    await session.stop();
    await started;
    expect(session.getSnapshot()).toMatchObject({ phase: 'ended', error: null, resultConnection: 'closed' });
    expect(endRequests()).toHaveLength(1);
    expect(latest().detached).toBe(true);
    await jest.advanceTimersByTimeAsync(60_000);
    expect(socketKinds()).toEqual(['result']);
  });

  it('ends in error when POST /end is never answered', async () => {
    server.endStatuses = [NO_ANSWER, NO_ANSWER, NO_ANSWER, NO_ANSWER];
    const { session, resultSocket } = await startSession();
    const stopped = session.stop();
    // Four requests of 15 seconds each, with waits of 1, 2, and 5 seconds between them.
    await jest.advanceTimersByTimeAsync(67_999);
    expect(session.getSnapshot().phase).toBe('stopping');
    await jest.advanceTimersByTimeAsync(1);
    await stopped;

    expect(endRequests()).toHaveLength(4);
    expect(session.getSnapshot()).toMatchObject({ phase: 'error', error: 'The request timed out.', resultConnection: 'closed' });
    expect(resultSocket.readyState).toBe(FakeSocket.CLOSED);
  });

  it('ends in error when POST /end keeps answering 503', async () => {
    server.endStatuses = [503, 503, 503, 503];
    const { session, resultSocket } = await startSession();
    const stopped = session.stop();
    await jest.advanceTimersByTimeAsync(8_000);
    await stopped;

    expect(endRequests()).toHaveLength(4);
    expect(session.getSnapshot()).toMatchObject({ phase: 'error', error: 'Temporarily unavailable.', resultConnection: 'closed' });
    expect(resultSocket.readyState).toBe(FakeSocket.CLOSED);
  });
});

// socket open만으로 OS 캡처를 시작하면 permit/key 준비 전 데이터가 유출된다.
test('permit과 모델키 준비 완료 후 마이크를 시작한다', async () => {
  const { session, microphone } = createSession();
  const held = gate();
  microphone.authorizationGate = held.opened;
  const starting = session.start({ sourceLanguage: 'ko-KR', targetLanguage: 'en-US', clientVad: false });
  await flush();
  expect(session.getSnapshot().audioConnection).toBe('open');
  expect(session.getSnapshot().phase).toBe('connecting');
  expect(microphone.capturing).toBe(false);
  held.open();
  await starting;
  expect(microphone.capturing).toBe(true);
});
