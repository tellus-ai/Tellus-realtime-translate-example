import {
  buildAudioWebSocketUrl,
  buildResultWebSocketUrl,
  createConversation,
  endConversation,
  saveInterpretationSettings,
  type RealtimeEndpoints,
  type StartConversationInput,
} from '../api/conversationApi';
import type { MicrophoneRecorder } from '../audio/NativeMicrophone';
import type { AudioChunk } from '@tellus-ai/audio-sdk/react-native';
import type { VadSnapshot } from '../audio/VADTypes';

const DISABLED_VAD_SNAPSHOT: VadSnapshot = { enabled: false, ready: false, mode: 'disabled', gate: 'closed' };
const INITIAL_SILERO_VAD_SNAPSHOT: VadSnapshot = { ...DISABLED_VAD_SNAPSHOT, enabled: true, mode: 'silero' };
import { decideSocketClose, STABLE_CONNECTION_MS, type RealtimeSocket, type SystemError } from './closePolicy';
import { parseSocketMessage } from './resultParser';
import { applyResultEvent, awaitsFinal } from './transcriptReducer';
import type { ConnectionStatus, SessionSnapshot } from './types';

const SOCKET_OPEN_TIMEOUT = 10_000;
const LAST_FINAL_TIMEOUT = 2_000;
const CONVERSATION_ENDED_TIMEOUT = 5_000;
type Listener = (snapshot: SessionSnapshot) => void;
type Timer = ReturnType<typeof setTimeout>;
type NativeWebSocketConstructor = new (
  url: string,
  protocols?: string | string[] | null,
  options?: { headers?: Record<string, string> },
) => WebSocket;
/** A socket that is not usable yet: `/audio` before `open`, Result before `participants.snapshot`. */
interface PendingOpen { timeout: Timer; resolve(usable: boolean): void }

export class RealtimeTranslationSession {
  private snapshot: SessionSnapshot = { phase: 'idle', conversationId: null, resultConnection: 'closed', audioConnection: 'closed', rows: [], error: null, vad: DISABLED_VAD_SNAPSHOT };
  private listeners = new Set<Listener>();
  private sockets: Record<RealtimeSocket, WebSocket | null> = { result: null, audio: null };
  // The server explains an error close with a `system.error` just before it.
  private lastSocketError: Record<RealtimeSocket, SystemError | null> = { result: null, audio: null };
  private pendingOpen: Record<RealtimeSocket, PendingOpen | null> = { result: null, audio: null };
  // Closed sockets that the next reconnect attempt reopens.
  private socketsToReopen = new Set<RealtimeSocket>();
  private reconnectAttempt = 0;
  private reconnectTimer: Timer | null = null;
  private reconnectQueue: Promise<void> = Promise.resolve();
  private reconnectPreparation: Promise<void> | null = null;
  private stableTimer: Timer | null = null;
  // True once Stop, a failure, or the end of the Conversation started closing the session.
  private intentionalClose = false;
  // The `POST /end` that a failure started and that is still running. `stop()` waits for it.
  private pendingEnd: Promise<void> | null = null;
  private generation = 0;
  private sampleCursor = 0;
  private statusSequence = 0;
  private desiredPaused = false;
  private lifecycleQueue: Promise<void> = Promise.resolve();
  private clientVad = false;
  private acceptingAudio = false;
  private audioCloseTimer: Timer | null = null;

  constructor(
    private readonly endpoints: RealtimeEndpoints,
    private readonly microphone: MicrophoneRecorder,
    private readonly accessToken: string,
  ) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  getSnapshot(): SessionSnapshot { return this.snapshot; }

  async start(input: StartConversationInput): Promise<void> {
    if (!this.accessToken) throw new Error('Set the API_KEY environment variable.');
    if (!input.sourceLanguage || !input.targetLanguage) throw new Error('Select two languages.');
    if (input.sourceLanguage === input.targetLanguage) throw new Error('Select two different languages.');
    if (!['idle', 'ended', 'error'].includes(this.snapshot.phase)) return;
    const generation = ++this.generation;
    this.intentionalClose = false;
    this.reconnectAttempt = 0;
    this.sampleCursor = 0;
    this.statusSequence = 0;
    this.desiredPaused = false;
    this.clientVad = input.clientVad;
    this.acceptingAudio = false;
    this.update({
      phase: 'creating',
      rows: [],
      error: null,
      conversationId: null,
      vad: input.clientVad ? INITIAL_SILERO_VAD_SNAPSHOT : DISABLED_VAD_SNAPSHOT,
    });
    try {
      await this.microphone.prepare(input.clientVad);
      if (generation !== this.generation) return;
      if (input.clientVad) this.update({ vad: { ...INITIAL_SILERO_VAD_SNAPSHOT, ready: true } });
      const conversationId = await createConversation(this.endpoints, this.accessToken);
      if (generation !== this.generation) {
        await endConversation(this.endpoints, this.accessToken, conversationId).catch(() => {});
        return;
      }
      this.update({ phase: 'configuring', conversationId });
      await saveInterpretationSettings(this.endpoints, this.accessToken, conversationId, input.sourceLanguage, input.targetLanguage, input.clientVad);
      if (generation !== this.generation) return;
      this.update({ phase: 'connecting' });
      // Result first: `/audio` is opened only after Result is ready. A socket that does not
      // become usable has already failed the start in `handleSocketClose`.
      if (!await this.openSocket('result', conversationId) || generation !== this.generation) return;
      if (!await this.openSocket('audio', conversationId) || generation !== this.generation) return;
      this.resetAudioStream();
      this.sendAudioStatus('capturing');
      this.update({ phase: 'recording' });
      this.acceptingAudio = true;
      await this.microphone.start(
        (frame) => this.handleAudioFrame(frame),
        (error) => {
          if (generation === this.generation && !this.intentionalClose) {
            this.failActiveSession(error.message);
          }
        },
      );
      // The session ended while the microphone was starting. Nothing else stops it now.
      if (generation !== this.generation) {
        await this.microphone.stop().catch(() => {});
        return;
      }
      // Pause or a `/audio` close arrived while the microphone was starting.
      if (this.snapshot.phase !== 'recording') await this.microphone.pause().catch(() => {});
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
  stop(): Promise<void> {
    return this.enqueueLifecycle(() => this.stopNow());
  }

  private async pauseNow(): Promise<void> {
    // `/audio` is down and the microphone is already paused: `resumeAudio` comes back paused.
    if (this.snapshot.phase === 'reconnecting') this.desiredPaused = true;
    if (this.snapshot.phase !== 'recording') return;
    const generation = this.generation;
    this.desiredPaused = true;
    this.acceptingAudio = false;
    try {
      await this.microphone.pause();
      if (generation !== this.generation || this.snapshot.phase !== 'recording') return;
      if (this.clientVad) {
        this.closeOpenVadGate('capturing');
        this.update({ vad: { ...INITIAL_SILERO_VAD_SNAPSHOT, ready: true } });
      }
      this.sendAudioStatus('paused');
      this.update({ phase: 'paused' });
    } catch (error) {
      if (generation === this.generation && !this.intentionalClose) {
        this.failActiveSession(error instanceof Error ? error.message : String(error));
      }
    }
  }

  private async resumeNow(): Promise<void> {
    if (this.snapshot.phase !== 'paused') return;
    const generation = this.generation;
    this.desiredPaused = false;
    if (this.clientVad) {
      this.update({ vad: { ...INITIAL_SILERO_VAD_SNAPSHOT, ready: true } });
    }
    this.sendAudioStatus('capturing');
    this.update({ phase: 'recording' });
    this.acceptingAudio = true;
    try {
      await this.microphone.resume();
    } catch (error) {
      if (generation === this.generation && !this.intentionalClose) {
        this.failActiveSession(error instanceof Error ? error.message : String(error));
      }
      return;
    }
    const phaseAfterResume = this.getSnapshot().phase;
    if (generation !== this.generation || this.intentionalClose || phaseAfterResume !== 'recording') {
      await this.microphone.pause().catch(() => {});
    }
  }

  private async stopNow(): Promise<void> {
    // Nothing to stop, or the session is already closing. A failure can still be ending the
    // Conversation; the caller gets to wait for that.
    if (this.intentionalClose || ['idle', 'ended', 'error'].includes(this.snapshot.phase)) {
      await this.pendingEnd;
      return;
    }
    ++this.generation;
    this.intentionalClose = true;
    this.update({ phase: 'stopping' });
    await this.microphone.stop().catch(() => {});
    this.acceptingAudio = false;
    if (this.clientVad) this.closeOpenVadGate('capturing');
    this.sendAudioStatus('idle');
    const conversationId = this.snapshot.conversationId;
    // The statuses above make the server finish the last utterance; its finals arrive on Result.
    await this.waitForSnapshot((snapshot) => snapshot.resultConnection !== 'open' || !snapshot.rows.some(awaitsFinal), LAST_FINAL_TIMEOUT);
    await this.cleanupLocal({ keepResultSocket: true });
    try {
      if (conversationId && this.accessToken) await endConversation(this.endpoints, this.accessToken, conversationId);
      // `conversation.ended` and the HTTP response arrive in either order, and results can
      // still arrive until then. `handleSocketMessage` closes the socket on `conversation.ended`.
      await this.waitForSnapshot((snapshot) => snapshot.resultConnection !== 'open', CONVERSATION_ENDED_TIMEOUT);
      this.closeSocket('result');
      this.update({ phase: 'ended' });
    } catch (error) {
      this.closeSocket('result');
      this.update({ phase: 'error', error: error instanceof Error ? error.message : String(error) });
    }
  }

  /** Resolves when the snapshot satisfies `done`, or after `timeoutMs`. */
  private waitForSnapshot(done: (snapshot: SessionSnapshot) => boolean, timeoutMs: number): Promise<void> {
    if (done(this.snapshot)) return Promise.resolve();
    return new Promise((resolve) => {
      const finish = () => { clearTimeout(timeout); unsubscribe(); resolve(); };
      const timeout = setTimeout(finish, timeoutMs);
      const unsubscribe = this.subscribe((snapshot) => { if (done(snapshot)) finish(); });
    });
  }

  /**
   * Opens a new socket in place of the current one. Resolves `true` once it is usable: `open`
   * for `/audio`, `participants.snapshot` for Result. Resolves `false` when it closed, timed out,
   * or was closed by this client first; whoever closed it has already decided what happens next.
   */
  private openSocket(kind: RealtimeSocket, conversationId: string): Promise<boolean> {
    this.closeSocket(kind);
    this.lastSocketError[kind] = null;
    const NativeWebSocket = WebSocket as unknown as NativeWebSocketConstructor;
    const url = kind === 'result' ? buildResultWebSocketUrl(this.endpoints, conversationId) : buildAudioWebSocketUrl(this.endpoints, conversationId);
    const socket = new NativeWebSocket(url, null, { headers: { Origin: this.endpoints.appOrigin } });
    if (kind === 'audio') socket.binaryType = 'arraybuffer';
    this.sockets[kind] = socket;
    this.setConnection(kind, 'connecting');
    // Every handler is attached before `open`: the server accepts a connection first and can
    // reject it right after with `system.error` and a close.
    socket.onopen = () => {
      this.setConnection(kind, 'open');
      if (kind === 'audio') clearTimeout(this.pendingOpen.audio?.timeout);
    };
    socket.onmessage = (event) => this.handleSocketMessage(kind, event.data);
    socket.onerror = () => this.setConnection(kind, 'error');
    // A React Native close event can lack the code (0 or undefined) or the reason. That is
    // handled like a connection lost without a close frame.
    socket.onclose = (event) => this.handleSocketClose(kind, typeof event.code === 'number' && event.code > 0 ? event.code : 1006, typeof event.reason === 'string' ? event.reason : '');
    return new Promise((resolve) => {
      // No answer in time is handled like a connection lost without a close frame.
      const timeout = setTimeout(() => this.handleSocketClose(kind, 1006, ''), SOCKET_OPEN_TIMEOUT);
      this.pendingOpen[kind] = { timeout, resolve };
      if (kind === 'audio') {
        const onError = (error: Error) => {
          if (socket === this.sockets.audio && !this.intentionalClose) this.handleAuthorizationError(error);
        };
        void this.microphone.authorize(socket, conversationId, this.accessToken, onError).then(() => {
          if (socket === this.sockets.audio && this.audioCloseTimer === null) this.settleOpen('audio', true);
        }, onError);
      }
    });
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
    if (kind === 'audio') {
      this.acceptingAudio = false;
      this.microphone.releaseAuthorization();
      if (this.audioCloseTimer !== null) clearTimeout(this.audioCloseTimer);
      this.audioCloseTimer = null;
    }
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.close(1000);
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
    // The server sends nothing else on `/audio`.
    if (kind === 'audio') return;
    if (parsed.kind === 'ready') this.settleOpen('result', true);
    else if (parsed.kind === 'result') this.update({ rows: applyResultEvent(this.snapshot.rows, parsed.event) });
    else if (parsed.kind === 'error') this.update({ error: parsed.message });
    else if (parsed.kind === 'ended') {
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
    if (decision.action === 'fail') this.failActiveSession(decision.message, decision.endConversation);
    else if (this.snapshot.phase === 'connecting') {
      // Nothing is running yet that a reconnect could resume, so any close fails the start.
      // A Conversation that the server reports as ended needs no `POST /end`.
      const cause = `${kind} closed: ${code} ${decision.reason ?? ''}`.trimEnd();
      this.failActiveSession(`The realtime connection closed while starting. (${cause})`, decision.action === 'reconnect');
    } else if (decision.action === 'ended') this.finishEnded();
    else this.scheduleReconnect(kind, decision.delayMs);
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
    this.update({ phase: 'reconnecting' });
    this.reconnectPreparation ??= this.prepareForReconnect().catch((error) => {
      this.failActiveSession(error instanceof Error ? error.message : String(error));
    });
  }
  private async prepareForReconnect(): Promise<void> {
    this.acceptingAudio = false;
    await this.microphone.pause().catch(() => {});
    if (this.intentionalClose || !this.clientVad) return;
    this.update({ vad: { ...INITIAL_SILERO_VAD_SNAPSHOT, ready: true } });
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
    const superseded = () => this.intentionalClose || generation !== this.generation || this.reconnectTimer !== null;
    if (!conversationId || superseded() || this.socketsToReopen.size === 0) return;
    // Result first: `/audio` is opened only after Result is ready.
    if (this.socketsToReopen.has('result')) {
      if (!await this.openSocket('result', conversationId) || superseded()) return;
    }
    if (this.socketsToReopen.has('audio')) {
      await this.reconnectPreparation;
      if (superseded()) return;
      this.reconnectPreparation = null;
      this.resetAudioStream();
      if (!await this.openSocket('audio', conversationId)) return;
      await this.resumeAudio(generation);
    }
    if (superseded() || this.socketsToReopen.size > 0) return;
    // The server can close a socket right after accepting it, so the backoff starts over only
    // after both sockets stayed open for a while.
    this.stableTimer = setTimeout(() => { this.stableTimer = null; this.reconnectAttempt = 0; }, STABLE_CONNECTION_MS);
  }
  /** A new `/audio` socket counts samples from 0 again, with a closed VAD gate. */
  private resetAudioStream(): void {
    this.sampleCursor = 0;
    if (!this.clientVad) return;
    this.update({ vad: { ...INITIAL_SILERO_VAD_SNAPSHOT, ready: true } });
  }
  private async resumeAudio(generation: number): Promise<void> {
    // The socket that just opened can already be closed again.
    if (this.intentionalClose || generation !== this.generation || this.socketsToReopen.has('audio')) return;
    // The status goes out before any audio on the new socket.
    this.sendAudioStatus(this.desiredPaused ? 'paused' : 'capturing');
    this.update({ phase: this.desiredPaused ? 'paused' : 'recording' });
    if (this.desiredPaused) return;
    this.acceptingAudio = true;
    await this.microphone.resume();
    // Stop, Pause, or another close arrived while the microphone was resuming.
    if (this.intentionalClose || generation !== this.generation || this.snapshot.phase !== 'recording') await this.microphone.pause().catch(() => {});
  }
  private handleAudioFrame(chunk: AudioChunk): void {
    if (!this.acceptingAudio || !['recording', 'stopping'].includes(this.snapshot.phase)) return;
    const socket = this.sockets.audio;
    if (socket?.readyState !== WebSocket.OPEN) return;
    if (this.clientVad && (chunk.gateEvent === 'speech_gate_opened' || chunk.gateEvent === 'speech_gate_closed')) {
      const open = chunk.gateEvent === 'speech_gate_opened';
      this.update({ vad: { ...this.snapshot.vad, gate: open ? 'open' : 'closed' } });
      this.sendAudioStatus('capturing', chunk.gateEvent);
    }
    const payload = chunk.data.microphone;
    if (!payload?.length) return;
    socket.send(payload.slice().buffer);
    this.sampleCursor += chunk.sampleCount;
  }

  private sendAudioStatus(state: 'capturing' | 'paused' | 'idle', event?: string): void {
    if (this.sockets.audio?.readyState !== WebSocket.OPEN) return;
    this.statusSequence += 1;
    this.sockets.audio.send(JSON.stringify({ type: 'audio.status', version: 1,
      status_seq: this.statusSequence, boundary_sample: this.sampleCursor, mic: { state },
      vad: { enabled: this.clientVad, ...(event ? { event } : {}) } }));
  }

  private handleAuthorizationError(error: Error): void {
    if (['engine_authorization_connection_closed', 'engine_authorization_connection_failed', 'engine_authorization_server_error'].includes(error.message)) {
      this.acceptingAudio = false;
      this.audioCloseTimer ??= setTimeout(() => this.handleSocketClose('audio', 1006, ''), SOCKET_OPEN_TIMEOUT);
    } else if (['engine_authorization_timeout', 'engine_authorization_expired'].includes(error.message)) {
      this.handleSocketClose('audio', 1006, '');
    } else this.failActiveSession(error.message);
  }
  /** Stop keeps the Result socket for the last results and `conversation.ended`. */
  private async cleanupLocal({ keepResultSocket = false } = {}): Promise<void> {
    this.clearReconnectTimer();
    this.clearStableTimer();
    this.socketsToReopen.clear();
    this.reconnectPreparation = null;
    // The sockets go first, so that no event arrives while the rest is released.
    this.closeSocket('audio');
    if (!keepResultSocket) this.closeSocket('result');
    await this.microphone.stop().catch(() => {});
  }
  private enqueueLifecycle(operation: () => Promise<void>): Promise<void> {
    const result = this.lifecycleQueue.then(operation);
    this.lifecycleQueue = result.catch(() => {});
    return result;
  }
  private closeOpenVadGate(micState: 'capturing' | 'paused'): void {
    if (!this.clientVad || this.snapshot.vad.gate !== 'open') return;
    this.sendAudioStatus(micState, 'speech_gate_closed');
    this.update({ vad: { ...this.snapshot.vad, gate: 'closed' } });
  }

  /** The server reported the end of the Conversation, so there is nothing left for `POST /end`. */
  private finishEnded(): void {
    this.intentionalClose = true;
    ++this.generation;
    void this.cleanupLocal().then(() => this.update({ phase: 'ended', error: null }));
  }
  private failActiveSession(message: string, shouldEndConversation = true): void {
    if (this.intentionalClose) return;
    this.intentionalClose = true;
    ++this.generation;
    const conversationId = this.snapshot.conversationId;
    void this.cleanupLocal().then(() => {
      // The error shows once everything is released. `POST /end` can take several retries, so it
      // runs in the background.
      this.update({ phase: 'error', error: message });
      if (!shouldEndConversation || !conversationId || !this.accessToken) return;
      const pendingEnd: Promise<void> = endConversation(this.endpoints, this.accessToken, conversationId)
        .catch(() => {})
        .finally(() => { if (this.pendingEnd === pendingEnd) this.pendingEnd = null; });
      this.pendingEnd = pendingEnd;
    });
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
