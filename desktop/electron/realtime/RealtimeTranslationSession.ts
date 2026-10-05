import {
  attachEngineAuthorization,
  type AuthorizableAudioCapture,
  type EngineAuthorizationController,
  type EngineAuthorizationSocket,
} from '@tellus-ai/audio-sdk/authorization';
import type { RealtimeApi } from '../realtimeApi';
import type { StartConversationInput } from '../shared/desktopApi';
import type {
  ClientVadSnapshot,
  ConnectionStatus,
  SessionSnapshot,
  VadEvent,
  VadGate,
} from '../shared/realtimeTypes';
import {
  decideSocketClose,
  STABLE_CONNECTION_MS,
  type RealtimeSocket,
  type SystemError,
} from './closePolicy';
import { createNodeWebSocket } from './nodeWebSocket';
import { parseSocketMessage } from './resultParser';
import { applyResultEvent, awaitsFinal } from './transcriptReducer';
import {
  buildAudioStatusMessage,
  disabledVadSnapshot,
  resolveVadLevel,
  sileroVadSnapshot,
  type MicrophoneState,
} from './VADAudioStatus';

const SOCKET_OPEN_TIMEOUT = 10_000;
const LAST_FINAL_TIMEOUT = 2_000;
const CONVERSATION_ENDED_TIMEOUT = 5_000;
// The audio engine encodes 20 ms Opus frames at 16 kHz (see audio/audioEngine.ts).
const AUDIO_FORMAT = 'opus';
// `readyState` values of a WebSocket.
const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
// With these errors the authorization module reports that `/audio` is closing: it received a
// `system.error`, or it saw the close or a connection error itself.
const AUTHORIZATION_SOCKET_ERRORS = new Set([
  'engine_authorization_server_error',
  'engine_authorization_connection_closed',
  'engine_authorization_connection_failed',
]);
// Errors of the authorization module that a new `/audio` socket repairs, because it is
// authorized from the start: a request got no answer, or the permit ran out before a renewal
// succeeded. The server closes with the same `engine_authorization_expired` in that case, and
// either one can arrive first.
const AUTHORIZATION_RETRY_ERRORS = new Set(['engine_authorization_timeout', 'engine_authorization_expired']);

type Listener = (snapshot: SessionSnapshot) => void;

/**
 * A socket that is not usable yet: Result before `participants.snapshot`, `/audio` before the
 * engine is authorized.
 */
interface PendingOpen {
  timeout: NodeJS.Timeout;
  resolve(usable: boolean): void;
}

/**
 * The parts of a WebSocket the session and the authorization module use. The `ws` package and
 * the browser WebSocket both provide them, each with its own event types.
 */
export interface RealtimeWebSocket extends EngineAuthorizationSocket {
  onopen: ((event: any) => void) | null;
  onmessage: ((event: any) => void) | null;
  onclose: ((event: any) => void) | null;
  onerror: ((event: any) => void) | null;
  send(data: string | Uint8Array): void;
}

/** The parts of an audio engine chunk the session reads. */
export interface CapturedAudioChunk {
  data: { microphone?: Uint8Array };
  sampleCount: number;
  gateEvent?: string;
  discontinuity?: unknown;
}

export interface CaptureVadStatus {
  vadReady: boolean;
  vadGateState: string;
  vadProbability: number;
  vadIsSpeech: boolean;
}

/** The parts of the audio engine capture the session drives (`AudioCapture` in @tellus-ai/audio-sdk). */
export interface MicrophoneCapture extends AuthorizableAudioCapture {
  onError(callback: (error: Error | null, detail: { message: string; recoverable: boolean }) => unknown): void;
  start(callback: (error: Error | null, chunk: CapturedAudioChunk) => unknown): void;
  pause(): void;
  resume(): void;
  stop(): void;
  setVadEnabled(enabled: boolean): void;
  getStatus(): CaptureVadStatus;
}

export interface RealtimeEndpoints {
  websocketBaseUrl: string;
}

export class RealtimeTranslationSession {
  private snapshot: SessionSnapshot = {
    phase: 'idle',
    conversationId: null,
    resultConnection: 'closed',
    audioConnection: 'closed',
    rows: [],
    vad: disabledVadSnapshot(false),
    error: null,
  };
  private listeners = new Set<Listener>();
  private sockets: Record<RealtimeSocket, RealtimeWebSocket | null> = { result: null, audio: null };
  // The server explains an error close with a `system.error` just before it.
  private lastSocketError: Record<RealtimeSocket, SystemError | null> = { result: null, audio: null };
  private pendingOpen: Record<RealtimeSocket, PendingOpen | null> = { result: null, audio: null };
  // Closed sockets that the next reconnect attempt reopens.
  private socketsToReopen = new Set<RealtimeSocket>();
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectQueue: Promise<void> = Promise.resolve();
  private stableTimer: NodeJS.Timeout | null = null;
  private capture: MicrophoneCapture | null = null;
  // Bound to the current `/audio` socket. Disposing it invalidates the native permit, which
  // stops capture.
  private authorization: EngineAuthorizationController | null = null;
  // Set while `/audio` is about to close: the authorization module has given the socket up, so
  // capture has stopped. Pause and Resume do nothing until the close has been handled.
  private audioCloseTimer: NodeJS.Timeout | null = null;
  private captureStarted = false;
  // True once Stop, a failure, or the end of the Conversation started closing the session.
  private intentionalClose = false;
  // The `POST /end` that a failure started and that is still running. `stop()` waits for it.
  private pendingEnd: Promise<void> | null = null;
  private generation = 0;
  private lifecycleQueue: Promise<void> = Promise.resolve();
  private sampleCursor = 0;
  private statusSequence = 0;
  private desiredPaused = false;
  private acceptingAudio = false;
  private clientVad = false;
  // The engine reports gate transitions per capture; each new Audio WebSocket starts closed.
  private engineGate: VadGate = 'closed';
  private socketGate: VadGate = 'closed';

  constructor(
    private readonly endpoints: RealtimeEndpoints,
    private readonly api: RealtimeApi,
    private readonly createCapture: () => Promise<MicrophoneCapture>,
    private readonly getAccessToken: () => string | Promise<string>,
    private readonly createSocket: (url: string) => RealtimeWebSocket = createNodeWebSocket,
  ) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): SessionSnapshot {
    return this.snapshot;
  }

  isActive(): boolean {
    return !['idle', 'ended', 'error'].includes(this.snapshot.phase);
  }

  /** True while a failed session is still ending its Conversation in the background. */
  hasPendingEnd(): boolean {
    return this.pendingEnd !== null;
  }

  async start(input: StartConversationInput): Promise<void> {
    if (this.isActive()) return;
    if (input.sourceLanguage === input.targetLanguage) {
      this.update({ error: 'Select two different languages.' });
      return;
    }

    const generation = ++this.generation;
    this.intentionalClose = false;
    this.reconnectAttempt = 0;
    this.statusSequence = 0;
    this.desiredPaused = false;
    this.acceptingAudio = false;
    this.clientVad = input.clientVad;
    this.engineGate = 'closed';
    this.update({
      phase: 'preparing-audio',
      rows: [],
      error: null,
      conversationId: null,
      vad: input.clientVad ? sileroVadSnapshot(false) : disabledVadSnapshot(true),
    });

    try {
      const capture = await this.createCapture();
      if (generation !== this.generation) {
        capture.stop();
        return;
      }
      this.capture = capture;
      capture.setVadEnabled(input.clientVad);
      capture.onError((_error, detail) => {
        if (this.capture === capture && !detail.recoverable) {
          this.failActiveSession(`Audio capture failed: ${detail.message}`);
        }
      });
      this.update({
        phase: 'creating',
        vad: input.clientVad ? this.readVadSnapshot() : this.snapshot.vad,
      });

      const conversationId = await this.api.createConversation();
      if (generation !== this.generation) {
        await this.api.endConversation(conversationId).catch(() => {});
        return;
      }
      this.update({ phase: 'configuring', conversationId });
      await this.api.saveInterpretationSettings(conversationId, input);
      if (generation !== this.generation) return;
      this.update({ phase: 'connecting' });
      // Result first: `/audio` is opened only after Result is ready. A socket that does not
      // become usable has already failed the start in `handleSocketClose`.
      if (!await this.openSocket('result', conversationId) || generation !== this.generation) return;
      if (!await this.openSocket('audio', conversationId) || generation !== this.generation) return;

      // The initial status always precedes the first audio frame.
      this.sendAudioStatus('capturing', this.snapshot.vad);
      this.acceptingAudio = true;
      this.update({ phase: 'recording' });
      this.startCapture();
    } catch (error) {
      if (generation !== this.generation) return;
      this.failActiveSession(error instanceof Error ? error.message : String(error));
    }
  }

  pause(): Promise<void> {
    return this.enqueueLifecycle(() => this.pauseNow());
  }

  resume(): Promise<void> {
    return this.enqueueLifecycle(() => this.resumeNow());
  }

  /** `waitForResults: false` skips the waits for the last results, for when nobody is left to read them. */
  stop({ waitForResults = true } = {}): Promise<void> {
    return this.enqueueLifecycle(() => this.stopNow(waitForResults));
  }

  private async pauseNow(): Promise<void> {
    if (this.snapshot.phase !== 'recording' || this.audioCloseTimer !== null) return;
    this.desiredPaused = true;
    this.acceptingAudio = false;
    try {
      this.capture?.pause();
      const vad = this.idleVadSnapshot();
      this.closeSocketGate(vad);
      this.sendAudioStatus('paused', vad);
      this.update({ phase: 'paused', vad });
    } catch (error) {
      this.failActiveSession(error instanceof Error ? error.message : String(error));
    }
  }

  private async resumeNow(): Promise<void> {
    if (this.snapshot.phase !== 'paused' || this.audioCloseTimer !== null) return;
    try {
      this.desiredPaused = false;
      this.sendAudioStatus('capturing', this.snapshot.vad);
      this.update({ phase: 'recording' });
      this.acceptingAudio = true;
      if (this.captureStarted) this.capture?.resume();
      else this.startCapture();
    } catch (error) {
      this.acceptingAudio = false;
      this.failActiveSession(error instanceof Error ? error.message : String(error));
    }
  }

  private async stopNow(waitForResults: boolean): Promise<void> {
    // Nothing to stop, or the session is already closing. A failure can still be ending the
    // Conversation; the caller, such as the app when it quits, gets to wait for that.
    if (this.intentionalClose || !this.isActive()) {
      await this.pendingEnd;
      return;
    }
    this.intentionalClose = true;
    this.acceptingAudio = false;
    try {
      this.capture?.pause();
    } catch {
      // The capture is stopped below either way.
    }
    const vad = this.idleVadSnapshot();
    this.closeSocketGate(vad);
    this.sendAudioStatus('idle', vad);
    this.update({ phase: 'stopping', vad });
    const conversationId = this.snapshot.conversationId;
    ++this.generation;

    // The statuses above make the server finish the last utterance; its finals arrive on Result.
    if (waitForResults) {
      await this.waitForSnapshot(
        (snapshot) => snapshot.resultConnection !== 'open' || !snapshot.rows.some(awaitsFinal),
        LAST_FINAL_TIMEOUT,
      );
    }
    this.cleanupLocal({ keepResultSocket: true });
    try {
      if (conversationId) {
        await this.api.endConversation(conversationId);
      }
      // `conversation.ended` and the HTTP response arrive in either order, and results can
      // still arrive until then. `handleSocketMessage` closes the socket on `conversation.ended`.
      if (waitForResults) {
        await this.waitForSnapshot(
          (snapshot) => snapshot.resultConnection !== 'open',
          CONVERSATION_ENDED_TIMEOUT,
        );
      }
      this.closeSocket('result');
      this.update({ phase: 'ended', vad: disabledVadSnapshot(false) });
    } catch (error) {
      this.closeSocket('result');
      this.update({ phase: 'error', error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Resolves when the snapshot satisfies `done`, or after `timeoutMs`. */
  private waitForSnapshot(
    done: (snapshot: SessionSnapshot) => boolean,
    timeoutMs: number,
  ): Promise<void> {
    if (done(this.snapshot)) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timeout);
        unsubscribe();
        resolve();
      };
      const timeout = setTimeout(finish, timeoutMs);
      const unsubscribe = this.subscribe((snapshot) => {
        if (done(snapshot)) finish();
      });
    });
  }

  private handleChunk(capture: MicrophoneCapture, error: Error | null, chunk: CapturedAudioChunk): void {
    if (capture !== this.capture) return;
    if (error) {
      this.failActiveSession(`Audio capture failed: ${error.message}`);
      return;
    }
    if (this.clientVad) {
      if (chunk.gateEvent === 'speech_gate_opened') this.engineGate = 'open';
      else if (chunk.gateEvent === 'speech_gate_closed') this.engineGate = 'closed';
      // A dropped chunk may have carried a gate transition, so re-read the gate after a gap.
      else if (chunk.discontinuity) this.engineGate = capture.getStatus().vadGateState === 'open' ? 'open' : 'closed';
    }
    if (!this.acceptingAudio) return;

    if (this.clientVad) {
      const vad = this.readVadSnapshot();
      // Announce the engine gate on this socket before the frame it applies to. This also re-opens
      // the boundary on a new socket, or after a resume, when speech is already in progress.
      if (this.engineGate !== this.socketGate) {
        this.socketGate = this.engineGate;
        this.sendAudioStatus('capturing', vad, this.engineGate === 'open' ? 'speech_gate_opened' : 'speech_gate_closed');
      }
      if (!isSameVadState(vad, this.snapshot.vad)) this.update({ vad });
    }

    const payload = chunk.data.microphone;
    if (payload && payload.length > 0) this.sendAudioFrame(payload, chunk.sampleCount);
  }

  /**
   * Opens a new socket in place of the current one. Resolves `true` once it is usable:
   * `participants.snapshot` for Result, the engine authorization for `/audio`. Resolves `false`
   * when it closed, timed out, or was closed by this client first; whoever closed it has already
   * decided what happens next.
   */
  private openSocket(kind: RealtimeSocket, conversationId: string): Promise<boolean> {
    this.closeSocket(kind);
    this.lastSocketError[kind] = null;
    const id = encodeURIComponent(conversationId);
    const socket = this.createSocket(
      kind === 'result'
        ? `${this.endpoints.websocketBaseUrl}/conversations/${id}/results`
        : `${this.endpoints.websocketBaseUrl}/audio?conversation_id=${id}&audio_format=${AUDIO_FORMAT}`,
    );
    this.sockets[kind] = socket;
    this.setConnection(kind, 'connecting');
    // Every handler is attached before `open`: the server accepts a connection first and can
    // reject it right after with `system.error` and a close.
    socket.onopen = () => {
      this.setConnection(kind, 'open');
      // From here the engine authorization decides, and it has its own timeout.
      if (kind === 'audio') clearTimeout(this.pendingOpen.audio?.timeout);
    };
    socket.onmessage = (event: { data: unknown }) => this.handleSocketMessage(kind, event.data);
    socket.onerror = () => this.setConnection(kind, 'error');
    socket.onclose = (event: { code: number; reason: string }) =>
      this.handleSocketClose(kind, event.code, event.reason);
    const usable = new Promise<boolean>((resolve) => {
      // No answer in time is handled like a connection lost without a close frame.
      const timeout = setTimeout(() => this.handleSocketClose(kind, 1006, ''), SOCKET_OPEN_TIMEOUT);
      this.pendingOpen[kind] = { timeout, resolve };
    });
    // After the handlers above: listeners run in the order they were added, and the session has
    // to keep a `system.error` before the authorization module gives the socket up over it.
    if (kind === 'audio') this.authorizeAudio(socket, conversationId);
    return usable;
  }

  /** Binds the engine authorization to a new `/audio` socket. Capture can start once it is approved. */
  private authorizeAudio(socket: RealtimeWebSocket, conversationId: string): void {
    const capture = this.capture;
    if (!capture) throw new Error('Audio capture is unavailable.');
    // Each Audio WebSocket counts samples from zero; status_seq keeps increasing for the conversation.
    this.sampleCursor = 0;
    this.socketGate = 'closed';
    const onError = (error: Error) => {
      // Nothing to do for a socket that this client closed or replaced.
      if (socket === this.sockets.audio && !this.intentionalClose) this.handleAuthorizationError(error);
    };
    const authorization = attachEngineAuthorization(socket, capture, {
      conversationId,
      getAccessToken: this.getAccessToken,
      onError,
    });
    this.authorization = authorization;
    authorization.ready.then(() => {
      // A `system.error` can follow the approval at once; that socket never becomes usable.
      if (socket === this.sockets.audio && this.audioCloseTimer === null) this.settleOpen('audio', true);
    }, onError);
  }

  /**
   * The authorization module reports why it gave the `/audio` socket up. By then it has
   * invalidated the native permit, so capture has stopped.
   */
  private handleAuthorizationError(error: Error): void {
    if (AUTHORIZATION_SOCKET_ERRORS.has(error.message)) {
      // Not a failure in itself: the close that follows decides, as after any `system.error`.
      // If no close arrives, this is handled like a connection lost without a close frame.
      this.acceptingAudio = false;
      this.audioCloseTimer ??= setTimeout(() => this.handleSocketClose('audio', 1006, ''), SOCKET_OPEN_TIMEOUT);
    } else if (AUTHORIZATION_RETRY_ERRORS.has(error.message)) {
      this.handleSocketClose('audio', 1006, '');
    } else {
      // The engine was denied or the reply was not valid: a new socket would not change that.
      this.failActiveSession(error.message);
    }
  }

  private startCapture(): void {
    const capture = this.capture;
    if (!capture) throw new Error('Audio capture is unavailable.');
    capture.start((error, chunk) => this.handleChunk(capture, error, chunk));
    this.captureStarted = true;
  }

  private settleOpen(kind: RealtimeSocket, usable: boolean): void {
    const pending = this.pendingOpen[kind];
    if (!pending) return;
    this.pendingOpen[kind] = null;
    clearTimeout(pending.timeout);
    if (usable) this.socketsToReopen.delete(kind);
    pending.resolve(usable);
  }

  /** Detaches the handlers first, so a late event from this socket cannot touch its replacement. */
  private closeSocket(kind: RealtimeSocket): void {
    const socket = this.sockets[kind];
    if (!socket) return;
    this.sockets[kind] = null;
    this.settleOpen(kind, false);
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    if (kind === 'audio') {
      if (this.audioCloseTimer !== null) clearTimeout(this.audioCloseTimer);
      this.audioCloseTimer = null;
      // Disposing the authorization stops native capture. The next `/audio` socket has to be
      // authorized before capture starts again.
      this.authorization?.dispose();
      this.authorization = null;
      this.captureStarted = false;
    }
    if (socket.readyState === SOCKET_OPEN || socket.readyState === SOCKET_CONNECTING) {
      socket.close(1000);
    }
    this.setConnection(kind, 'closed');
  }

  private setConnection(kind: RealtimeSocket, status: ConnectionStatus): void {
    this.update(kind === 'result' ? { resultConnection: status } : { audioConnection: status });
  }

  private handleSocketMessage(kind: RealtimeSocket, raw: unknown): void {
    const parsed = parseSocketMessage(raw);
    if (parsed.kind === 'system-error') {
      // Not shown yet: the close that follows decides whether this ends the session.
      this.lastSocketError[kind] = parsed.error;
      return;
    }
    // The authorization module reads the other messages on `/audio`.
    if (kind === 'audio') return;

    if (parsed.kind === 'ready') {
      // Result does not send again what it sent while this client was disconnected, and the
      // example does not recover it: after a reconnect only later results arrive.
      this.settleOpen('result', true);
    } else if (parsed.kind === 'result') {
      this.update({ rows: applyResultEvent(this.snapshot.rows, parsed.event) });
    } else if (parsed.kind === 'error') {
      this.update({ error: parsed.message });
    } else if (parsed.kind === 'ended') {
      // After Stop this is the answer to this client's own `POST /end`, and `stopNow` goes on.
      if (this.intentionalClose) this.closeSocket('result');
      else this.finishEnded();
    }
  }

  /** Handles a close that this client did not start. `closeSocket` detaches its own closes. */
  private handleSocketClose(kind: RealtimeSocket, code: number, reason: string): void {
    const lastError = this.lastSocketError[kind];
    this.closeSocket(kind);
    if (this.intentionalClose) return;

    const decision = decideSocketClose({ code, reason, lastError, attempt: this.reconnectAttempt });
    if (decision.action === 'fail') {
      this.failActiveSession(decision.message, decision.endConversation);
    } else if (this.snapshot.phase === 'connecting') {
      // Nothing is running yet that a reconnect could resume, so any close fails the start.
      // A Conversation that the server reports as ended needs no `POST /end`.
      const cause = `${kind} closed: ${code} ${decision.reason ?? ''}`.trimEnd();
      this.failActiveSession(
        `The realtime connection closed while starting. (${cause})`,
        decision.action === 'reconnect',
      );
    } else if (decision.action === 'ended') {
      this.finishEnded();
    } else {
      this.scheduleReconnect(kind, decision.delayMs);
    }
  }

  private scheduleReconnect(kind: RealtimeSocket, delayMs: number): void {
    this.clearStableTimer();
    this.socketsToReopen.add(kind);
    if (kind === 'audio') this.suspendAudio();
    // An attempt that is already waiting reopens this socket as well.
    if (this.reconnectTimer !== null) return;
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => this.reconnectNow(), delayMs);
  }

  /** Recording continues while only Result is down, but not without `/audio`. */
  private suspendAudio(): void {
    this.acceptingAudio = false;
    // Capture stopped with the authorization of the closed socket, and starts again from a
    // closed gate.
    this.engineGate = 'closed';
    this.update({ phase: 'reconnecting', vad: this.idleVadSnapshot() });
  }

  private reconnectNow(): void {
    this.clearReconnectTimer();
    // One attempt at a time: a later one must not replace a socket that an earlier one is
    // still opening.
    this.reconnectQueue = this.reconnectQueue
      .then(() => this.reconnect())
      .catch((error) => this.failActiveSession(error instanceof Error ? error.message : String(error)));
  }

  private async reconnect(): Promise<void> {
    const conversationId = this.snapshot.conversationId;
    const generation = this.generation;
    // True when the session is closing, or when a close during this attempt has scheduled the
    // next one. That attempt reopens whatever is still closed, after its own delay.
    const superseded = () =>
      this.intentionalClose || generation !== this.generation || this.reconnectTimer !== null;
    if (!conversationId || superseded() || this.socketsToReopen.size === 0) return;

    // Result first: `/audio` is opened only after Result is ready.
    if (this.socketsToReopen.has('result')) {
      if (!await this.openSocket('result', conversationId) || superseded()) return;
    }
    if (this.socketsToReopen.has('audio')) {
      if (!await this.openSocket('audio', conversationId)) return;
      this.resumeAudio(generation);
    }
    if (superseded() || this.socketsToReopen.size > 0) return;
    // The server can close a socket right after accepting it, so the backoff starts over only
    // after both sockets stayed open for a while.
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null;
      this.reconnectAttempt = 0;
    }, STABLE_CONNECTION_MS);
  }

  private resumeAudio(generation: number): void {
    // The socket that just opened can already be closed again.
    if (this.intentionalClose || generation !== this.generation || this.socketsToReopen.has('audio')) return;
    // The status goes out before any audio on the new socket.
    this.sendAudioStatus(this.desiredPaused ? 'paused' : 'capturing', this.snapshot.vad);
    this.update({ phase: this.desiredPaused ? 'paused' : 'recording' });
    if (this.desiredPaused) return;
    this.acceptingAudio = true;
    this.startCapture();
  }

  private sendAudioFrame(frame: Uint8Array, sampleCount: number): void {
    const socket = this.sockets.audio;
    if (this.snapshot.phase !== 'recording' || socket?.readyState !== SOCKET_OPEN) return;
    socket.send(frame);
    this.sampleCursor += sampleCount;
  }

  private sendAudioStatus(state: MicrophoneState, vad: ClientVadSnapshot, event?: VadEvent): void {
    const socket = this.sockets.audio;
    if (socket?.readyState !== SOCKET_OPEN) return;
    this.statusSequence += 1;
    socket.send(JSON.stringify(buildAudioStatusMessage({
      statusSequence: this.statusSequence,
      sample: this.sampleCursor,
      microphoneState: state,
      vad,
      event,
    })));
  }

  /** Ends an open speech boundary on the current socket before a pause or stop status. */
  private closeSocketGate(vad: ClientVadSnapshot): void {
    if (!this.clientVad || this.socketGate !== 'open') return;
    this.socketGate = 'closed';
    this.sendAudioStatus('capturing', vad, 'speech_gate_closed');
  }

  private readVadSnapshot(): ClientVadSnapshot {
    const status = this.capture?.getStatus();
    const isSpeech = status?.vadIsSpeech ?? false;
    const probability = status?.vadProbability ?? 0;
    return {
      enabled: true,
      ready: status?.vadReady ?? false,
      mode: 'silero',
      gate: this.engineGate,
      isSpeech,
      probability,
      level: resolveVadLevel(true, isSpeech, probability),
    };
  }

  private idleVadSnapshot(): ClientVadSnapshot {
    return this.clientVad ? sileroVadSnapshot(this.snapshot.vad.ready) : this.snapshot.vad;
  }

  private enqueueLifecycle(operation: () => Promise<void>): Promise<void> {
    const result = this.lifecycleQueue.then(operation);
    this.lifecycleQueue = result.catch(() => {});
    return result;
  }

  /** Stop keeps the Result socket for the last results and `conversation.ended`. */
  private cleanupLocal({ keepResultSocket = false } = {}): void {
    this.acceptingAudio = false;
    this.clearReconnectTimer();
    this.clearStableTimer();
    this.socketsToReopen.clear();
    // The sockets go first, so that no event arrives while the rest is released.
    this.closeSocket('audio');
    if (!keepResultSocket) this.closeSocket('result');
    const capture = this.capture;
    this.capture = null;
    try {
      capture?.stop();
    } catch {
      // The native capture is released either way.
    }
  }

  /** The server reported the end of the Conversation, so there is nothing left for `POST /end`. */
  private finishEnded(): void {
    this.intentionalClose = true;
    this.acceptingAudio = false;
    ++this.generation;
    this.cleanupLocal();
    this.update({ phase: 'ended', vad: disabledVadSnapshot(false), error: null });
  }

  private failActiveSession(message: string, shouldEndConversation = true): void {
    if (this.intentionalClose) return;
    this.intentionalClose = true;
    this.acceptingAudio = false;
    ++this.generation;
    const conversationId = this.snapshot.conversationId;
    this.cleanupLocal();
    // The error shows at once. `POST /end` can take several retries, so it runs in the background.
    this.update({ phase: 'error', error: message });
    if (!shouldEndConversation || !conversationId) return;
    const pendingEnd: Promise<void> = this.api.endConversation(conversationId)
      .catch(() => {})
      .finally(() => {
        if (this.pendingEnd === pendingEnd) this.pendingEnd = null;
      });
    this.pendingEnd = pendingEnd;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearStableTimer(): void {
    if (this.stableTimer !== null) clearTimeout(this.stableTimer);
    this.stableTimer = null;
  }

  private update(patch: Partial<SessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener(this.snapshot));
  }
}

function isSameVadState(left: ClientVadSnapshot, right: ClientVadSnapshot): boolean {
  return left.ready === right.ready
    && left.gate === right.gate
    && left.isSpeech === right.isSpeech
    && left.level === right.level;
}
