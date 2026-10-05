import {
  buildAudioWebSocketUrl,
  buildResultWebSocketUrl,
  createConversation,
  endConversation,
  saveInterpretationSettings,
  type RealtimeEndpoints,
  type StartConversationInput,
} from '../api/conversationApi';
import type { MicrophoneRecorder } from '../audio/BrowserMicrophone';
import type { PcmFrame } from '../audio/PcmFramePipeline';
import {
  resolveRealtimeAudioFormat,
  type RealtimeAudioFormat,
} from '../audio/RealtimeAudioFormat';
import {
  OpusEncoderWorkerClient,
  type RealtimeAudioEncoder,
} from '../audio/opus/OpusEncoderWorkerClient';
import { VADSileroWorkerClient } from '../audio/vad/VADSileroWorkerClient';
import type { ClientVadProcessor, ClientVadSnapshot, VadDecision, VadEvent } from '../audio/vad/VADTypes';
import {
  buildAudioStatusMessage,
  disabledVadSnapshot,
  sileroVadSnapshot,
  type MicrophoneState,
} from './VADAudioStatus';
import {
  decideSocketClose,
  STABLE_CONNECTION_MS,
  type RealtimeSocket,
  type SystemError,
} from './closePolicy';
import { parseSocketMessage } from './resultParser';
import { applyResultEvent, awaitsFinal } from './transcriptReducer';
import type { ConnectionStatus, SessionSnapshot } from './types';

const SOCKET_OPEN_TIMEOUT = 10_000;
const MAX_PENDING_AUDIO_FRAMES = 10;
const LAST_FINAL_TIMEOUT = 2_000;
const CONVERSATION_ENDED_TIMEOUT = 5_000;

type Listener = (snapshot: SessionSnapshot) => void;
type VadProcessorFactory = () => ClientVadProcessor;

/** A socket that is not usable yet: `/audio` before `open`, Result before `participants.snapshot`. */
interface PendingOpen {
  timeout: number;
  resolve(usable: boolean): void;
}

export interface AudioEncodingDependencies {
  resolveFormat(): RealtimeAudioFormat;
  createOpusEncoder(): RealtimeAudioEncoder;
}

const DEFAULT_AUDIO_ENCODING_DEPENDENCIES: AudioEncodingDependencies = {
  resolveFormat: resolveRealtimeAudioFormat,
  createOpusEncoder: () => new OpusEncoderWorkerClient(),
};

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
  private sockets: Record<RealtimeSocket, WebSocket | null> = { result: null, audio: null };
  // The server explains an error close with a `system.error` just before it.
  private lastSocketError: Record<RealtimeSocket, SystemError | null> = { result: null, audio: null };
  private pendingOpen: Record<RealtimeSocket, PendingOpen | null> = { result: null, audio: null };
  // Closed sockets that the next reconnect attempt reopens.
  private socketsToReopen = new Set<RealtimeSocket>();
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private reconnectQueue: Promise<void> = Promise.resolve();
  private reconnectPreparation: Promise<void> | null = null;
  private stableTimer: number | null = null;
  // True once Stop, a failure, or the end of the Conversation started closing the session.
  private intentionalClose = false;
  // A failed session that is still closing, up to the end of its `POST /end`. `stop()` waits for it.
  private pendingEnd: Promise<void> | null = null;
  private generation = 0;
  private audioEpoch = 0;
  private audioQueue: Promise<void> = Promise.resolve();
  private lifecycleQueue: Promise<void> = Promise.resolve();
  private pendingAudioFrames = 0;
  private sampleCursor = 0;
  private nextFrameSample = 0;
  private statusSequence = 0;
  private desiredPaused = false;
  private acceptingAudio = false;
  private vadProcessor: ClientVadProcessor | null = null;
  private audioFormat: RealtimeAudioFormat = 'pcm16';
  private opusEncoder: RealtimeAudioEncoder | null = null;

  constructor(
    private readonly endpoints: RealtimeEndpoints,
    private readonly microphone: MicrophoneRecorder,
    private readonly accessToken: string,
    private readonly createVadProcessor: VadProcessorFactory = () => new VADSileroWorkerClient(),
    private readonly audioEncoding: AudioEncodingDependencies = DEFAULT_AUDIO_ENCODING_DEPENDENCIES,
  ) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getSnapshot(): SessionSnapshot {
    return this.snapshot;
  }

  async start(input: StartConversationInput): Promise<void> {
    if (!this.accessToken) throw new Error('Set the API_KEY environment variable.');
    if (!input.sourceLanguage || !input.targetLanguage) throw new Error('Select two languages.');
    if (input.sourceLanguage === input.targetLanguage) throw new Error('Select two different languages.');
    if (!['idle', 'ended', 'error'].includes(this.snapshot.phase)) return;

    const generation = ++this.generation;
    this.intentionalClose = false;
    this.reconnectAttempt = 0;
    this.sampleCursor = 0;
    this.nextFrameSample = 0;
    this.statusSequence = 0;
    this.desiredPaused = false;
    this.acceptingAudio = false;
    this.audioEpoch += 1;
    this.audioQueue = Promise.resolve();
    this.pendingAudioFrames = 0;
    this.update({
      phase: input.clientVad ? 'preparing-vad' : 'creating',
      rows: [],
      error: null,
      conversationId: null,
      vad: input.clientVad ? sileroVadSnapshot(false) : disabledVadSnapshot(true),
    });
    window.addEventListener('online', this.handleOnline);

    try {
      this.audioFormat = this.audioEncoding.resolveFormat();
      if (this.audioFormat === 'opus') {
        this.opusEncoder = this.audioEncoding.createOpusEncoder();
        await this.opusEncoder.initialize();
        if (generation !== this.generation) return;
      }

      if (input.clientVad) {
        this.vadProcessor = this.createVadProcessor();
        await this.vadProcessor.initialize();
        if (generation !== this.generation) return;
        this.update({ phase: 'creating', vad: sileroVadSnapshot(true) });
      }

      const conversationId = await createConversation(this.endpoints, this.accessToken);
      if (generation !== this.generation) {
        await endConversation(this.endpoints, this.accessToken, conversationId).catch(() => {});
        return;
      }
      this.update({ phase: 'configuring', conversationId });
      await saveInterpretationSettings(
        this.endpoints,
        this.accessToken,
        conversationId,
        input.sourceLanguage,
        input.targetLanguage,
        input.clientVad,
      );
      if (generation !== this.generation) return;
      this.update({ phase: 'connecting' });
      // Result first: `/audio` is opened only after Result is ready. A socket that does not
      // become usable has already failed the start in `handleSocketClose`.
      if (!await this.openSocket('result', conversationId) || generation !== this.generation) return;
      if (!await this.openSocket('audio', conversationId) || generation !== this.generation) return;

      const framesBeforeMicrophoneReady: PcmFrame[] = [];
      let microphoneReady = false;
      await this.microphone.start((frame) => {
        if (microphoneReady) this.enqueueAudioFrame(frame);
        else framesBeforeMicrophoneReady.push(frame);
      });
      if (generation !== this.generation) {
        await this.microphone.stop().catch(() => {});
        return;
      }
      // Initial status is always sent before any audio captured during microphone startup.
      this.sendAudioStatus('capturing', this.snapshot.vad);
      this.acceptingAudio = true;
      this.update({ phase: 'recording' });
      microphoneReady = true;
      for (const frame of framesBeforeMicrophoneReady) this.enqueueAudioFrame(frame);
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
    if (this.snapshot.phase !== 'recording') return;
    const generation = this.generation;
    // `/audio` can close, or the session can start closing, during any await below. The phase
    // then belongs to the reconnect: only `desiredPaused` is kept, and `resumeAudio` applies it.
    const interrupted = () => generation !== this.generation || this.snapshot.phase !== 'recording';
    this.desiredPaused = true;
    this.acceptingAudio = false;
    try {
      await this.microphone.pause();
      if (interrupted()) return;
      await this.drainAudioQueue();
      if (interrupted()) return;
      const event = this.snapshot.vad.enabled && this.snapshot.vad.gate === 'open'
        ? 'speech_gate_closed' as const
        : undefined;
      const vad = this.snapshot.vad.enabled ? sileroVadSnapshot(true) : this.snapshot.vad;
      if (this.vadProcessor) await this.vadProcessor.reset();
      if (interrupted()) return;
      if (event) this.sendAudioStatus('capturing', vad, event);
      this.sendAudioStatus('paused', vad);
      this.update({ phase: 'paused', vad });
    } catch (error) {
      if (generation === this.generation) {
        this.failActiveSession(error instanceof Error ? error.message : String(error));
      }
    }
  }

  private async resumeNow(): Promise<void> {
    if (this.snapshot.phase !== 'paused') return;
    const generation = this.generation;
    // As in `pauseNow`: after an interruption only `desiredPaused` is kept.
    const interrupted = () => generation !== this.generation || this.snapshot.phase !== 'paused';
    this.desiredPaused = false;
    try {
      if (this.vadProcessor) await this.vadProcessor.reset();
      if (interrupted()) return;
      const vad = this.snapshot.vad.enabled ? sileroVadSnapshot(true) : this.snapshot.vad;
      this.sendAudioStatus('capturing', vad);
      this.update({ phase: 'recording', vad });
      this.acceptingAudio = true;
      await this.microphone.resume();
      // `/audio` closed, or the session started closing, while the microphone was resuming.
      if (!this.acceptingAudio) await this.microphone.pause().catch(() => {});
    } catch (error) {
      this.acceptingAudio = false;
      if (generation === this.generation) {
        this.failActiveSession(error instanceof Error ? error.message : String(error));
      }
    }
  }

  private async stopNow(): Promise<void> {
    if (this.intentionalClose || ['idle', 'ended', 'error'].includes(this.snapshot.phase)) {
      // Nothing to stop, or the session is already closing. A failed session can still be
      // ending its Conversation; a caller that is about to leave waits for that here.
      await this.pendingEnd;
      return;
    }
    this.intentionalClose = true;
    this.acceptingAudio = false;
    await this.microphone.pause().catch(() => {});
    await this.drainAudioQueue();
    const event = this.snapshot.vad.enabled && this.snapshot.vad.gate === 'open'
      ? 'speech_gate_closed' as const
      : undefined;
    const stoppedVad = this.snapshot.vad.enabled ? sileroVadSnapshot(true) : this.snapshot.vad;
    if (event) this.sendAudioStatus('capturing', stoppedVad, event);
    this.sendAudioStatus('idle', stoppedVad);
    this.update({ phase: 'stopping', vad: stoppedVad });
    const conversationId = this.snapshot.conversationId;
    ++this.generation;
    this.audioEpoch += 1;

    // The statuses above make the server finish the last utterance; its finals arrive on Result.
    await this.waitForSnapshot(
      (snapshot) => snapshot.resultConnection !== 'open' || !snapshot.rows.some(awaitsFinal),
      LAST_FINAL_TIMEOUT,
    );
    await this.cleanupLocal({ keepResultSocket: true });
    try {
      if (conversationId && this.accessToken) {
        await endConversation(this.endpoints, this.accessToken, conversationId);
      }
      // `conversation.ended` and the HTTP response arrive in either order, and results can
      // still arrive until then. `handleSocketMessage` closes the socket on `conversation.ended`.
      await this.waitForSnapshot(
        (snapshot) => snapshot.resultConnection !== 'open',
        CONVERSATION_ENDED_TIMEOUT,
      );
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
        window.clearTimeout(timeout);
        unsubscribe();
        resolve();
      };
      const timeout = window.setTimeout(finish, timeoutMs);
      const unsubscribe = this.subscribe((snapshot) => {
        if (done(snapshot)) finish();
      });
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
    const socket = new WebSocket(
      kind === 'result'
        ? buildResultWebSocketUrl(this.endpoints, conversationId)
        : buildAudioWebSocketUrl(this.endpoints, conversationId, this.audioFormat),
    );
    if (kind === 'audio') socket.binaryType = 'arraybuffer';
    this.sockets[kind] = socket;
    this.setConnection(kind, 'connecting');
    // Every handler is attached before `open`: the server accepts a connection first and can
    // reject it right after with `system.error` and a close.
    socket.onopen = () => {
      this.setConnection(kind, 'open');
      if (kind === 'audio') this.settleOpen(kind, true);
    };
    socket.onmessage = (event) => this.handleSocketMessage(kind, event.data);
    socket.onerror = () => this.setConnection(kind, 'error');
    socket.onclose = (event) => this.handleSocketClose(kind, event.code, event.reason);
    return new Promise((resolve) => {
      // No answer in time is handled like a connection lost without a close frame.
      const timeout = window.setTimeout(() => this.handleSocketClose(kind, 1006, ''), SOCKET_OPEN_TIMEOUT);
      this.pendingOpen[kind] = { timeout, resolve };
    });
  }

  private settleOpen(kind: RealtimeSocket, usable: boolean): void {
    const pending = this.pendingOpen[kind];
    if (!pending) return;
    this.pendingOpen[kind] = null;
    window.clearTimeout(pending.timeout);
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
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
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
    // The server sends nothing else on `/audio`.
    if (kind === 'audio') return;

    if (parsed.kind === 'ready') {
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
    this.reconnectTimer = window.setTimeout(() => this.reconnectNow(), delayMs);
  }

  /** Recording continues while only Result is down, but not without `/audio`. */
  private suspendAudio(): void {
    this.acceptingAudio = false;
    this.update({ phase: 'reconnecting' });
    this.reconnectPreparation ??= this.prepareForReconnect().catch((error) => {
      this.failActiveSession(error instanceof Error ? error.message : String(error));
    });
  }

  private async prepareForReconnect(): Promise<void> {
    this.audioEpoch += 1;
    await this.microphone.pause().catch(() => {});
    await this.drainAudioQueue();
    if (this.vadProcessor) await this.vadProcessor.reset();
    if (this.opusEncoder) await this.opusEncoder.reset();
    if (this.intentionalClose) return;
    const vad = this.snapshot.vad.enabled ? sileroVadSnapshot(true) : this.snapshot.vad;
    this.update({ vad });
  }

  private reconnectNow(): void {
    this.clearReconnectTimer();
    // One attempt at a time: a later one must not replace a socket that an earlier one is
    // still opening.
    this.reconnectQueue = this.reconnectQueue
      .then(() => this.reconnect())
      .catch((error) => this.failActiveSession(error instanceof Error ? error.message : String(error)));
  }

  // An arrow function, so that the same reference can be removed from `window` again.
  private readonly handleOnline = (): void => {
    // The network is back, so the rest of the backoff wait is pointless.
    if (this.reconnectTimer !== null) this.reconnectNow();
  };

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
      await this.reconnectPreparation;
      if (superseded()) return;
      this.reconnectPreparation = null;
      // A new `/audio` socket counts samples from 0 again.
      this.sampleCursor = 0;
      this.nextFrameSample = 0;
      if (!await this.openSocket('audio', conversationId)) return;
      await this.resumeAudio(generation);
    }
    if (superseded() || this.socketsToReopen.size > 0) return;
    // The server can close a socket right after accepting it, so the backoff starts over only
    // after both sockets stayed open for a while.
    this.stableTimer = window.setTimeout(() => {
      this.stableTimer = null;
      this.reconnectAttempt = 0;
    }, STABLE_CONNECTION_MS);
  }

  private async resumeAudio(generation: number): Promise<void> {
    // The socket that just opened can already be closed again.
    if (this.intentionalClose || generation !== this.generation || this.socketsToReopen.has('audio')) return;
    // The status goes out before any audio on the new socket.
    this.sendAudioStatus(this.desiredPaused ? 'paused' : 'capturing', this.snapshot.vad);
    this.update({ phase: this.desiredPaused ? 'paused' : 'recording' });
    if (this.desiredPaused) return;
    this.acceptingAudio = true;
    await this.microphone.resume();
    // Stop, Pause, or another close arrived while the microphone was resuming.
    if (!this.acceptingAudio) await this.microphone.pause().catch(() => {});
  }

  private enqueueAudioFrame(frame: PcmFrame): void {
    if (!this.acceptingAudio) return;
    if (this.pendingAudioFrames >= MAX_PENDING_AUDIO_FRAMES) {
      this.failActiveSession('Audio processing latency exceeded 200 ms. The session was stopped safely.');
      return;
    }
    this.pendingAudioFrames += 1;
    const sampleStart = this.nextFrameSample;
    this.nextFrameSample += frame.samples.length;
    const epoch = this.audioEpoch;
    const generation = this.generation;
    this.audioQueue = this.audioQueue.then(async () => {
      if (epoch !== this.audioEpoch || generation !== this.generation) return;
      let event: VadEvent | undefined;
      let vad: ClientVadSnapshot | null = null;
      if (this.vadProcessor) {
        const decision: VadDecision = await this.vadProcessor.process({ samples: frame.samples, sampleStart });
        if (epoch !== this.audioEpoch || generation !== this.generation) return;
        const { event: nextEvent, lastSpeechSampleEnd: _lastSpeechSampleEnd, ...nextVad } = decision;
        event = nextEvent;
        vad = nextVad;
      }
      const payload = await this.encodeAudioFrame(frame.pcm16);
      if (epoch !== this.audioEpoch || generation !== this.generation) return;
      if (vad) {
        this.update({ vad });
        if (event) {
          // Both open and close events use the current monotonic uplink cursor.
          this.sendAudioStatus('capturing', vad, event, sampleStart);
        }
      }
      this.sendAudioFrame(payload, sampleStart, frame.samples.length);
    }).catch((error) => {
      if (epoch === this.audioEpoch && generation === this.generation) {
        this.failActiveSession(error instanceof Error ? error.message : String(error));
      }
    }).finally(() => {
      this.pendingAudioFrames = Math.max(0, this.pendingAudioFrames - 1);
    });
  }

  private async encodeAudioFrame(pcm16: ArrayBuffer): Promise<ArrayBuffer> {
    if (this.audioFormat === 'pcm16') return pcm16;
    if (!this.opusEncoder) throw new Error('Opus encoder is not initialized.');
    return this.opusEncoder.encode(pcm16);
  }

  private sendAudioFrame(frame: ArrayBuffer, sampleStart: number, sampleCount: number): void {
    const socket = this.sockets.audio;
    if (this.snapshot.phase !== 'recording' || socket?.readyState !== WebSocket.OPEN) return;
    if (sampleStart !== this.sampleCursor) {
      this.failActiveSession(`Audio sample cursor mismatch: ${sampleStart} != ${this.sampleCursor}`);
      return;
    }
    socket.send(frame);
    this.sampleCursor += sampleCount;
  }

  private sendAudioStatus(
    state: MicrophoneState,
    vad: ClientVadSnapshot,
    event?: VadEvent,
    sample = this.sampleCursor,
  ): void {
    const socket = this.sockets.audio;
    if (socket?.readyState !== WebSocket.OPEN) return;
    this.statusSequence += 1;
    socket.send(JSON.stringify(buildAudioStatusMessage({
      statusSequence: this.statusSequence,
      sample,
      microphoneState: state,
      vad,
      event,
    })));
  }

  private async drainAudioQueue(): Promise<void> {
    await this.audioQueue.catch(() => {});
  }

  private enqueueLifecycle(operation: () => Promise<void>): Promise<void> {
    const result = this.lifecycleQueue.then(operation);
    this.lifecycleQueue = result.catch(() => {});
    return result;
  }

  /** Stop keeps the Result socket for the last results and `conversation.ended`. */
  private async cleanupLocal({ keepResultSocket = false } = {}): Promise<void> {
    this.acceptingAudio = false;
    this.clearReconnectTimer();
    this.clearStableTimer();
    this.socketsToReopen.clear();
    this.reconnectPreparation = null;
    window.removeEventListener('online', this.handleOnline);
    // The sockets go first, so that no event arrives while the rest is released.
    this.closeSocket('audio');
    if (!keepResultSocket) this.closeSocket('result');
    await this.microphone.stop().catch(() => {});
    await this.vadProcessor?.dispose().catch(() => {});
    this.vadProcessor = null;
    await this.opusEncoder?.dispose().catch(() => {});
    this.opusEncoder = null;
  }

  /** The server reported the end of the Conversation, so there is nothing left for `POST /end`. */
  private finishEnded(): void {
    this.intentionalClose = true;
    this.acceptingAudio = false;
    ++this.generation;
    this.audioEpoch += 1;
    void this.cleanupLocal().then(() => {
      this.update({ phase: 'ended', vad: disabledVadSnapshot(false), error: null });
    });
  }

  private failActiveSession(message: string, shouldEndConversation = true): void {
    if (this.intentionalClose) return;
    this.intentionalClose = true;
    this.acceptingAudio = false;
    ++this.generation;
    this.audioEpoch += 1;
    const conversationId = this.snapshot.conversationId;
    const pendingEnd: Promise<void> = this.cleanupLocal()
      .then(async () => {
        // The error shows first: `POST /end` can take long when it is retried.
        this.update({ phase: 'error', error: message });
        if (shouldEndConversation && conversationId && this.accessToken) {
          await endConversation(this.endpoints, this.accessToken, conversationId).catch(() => {});
        }
      })
      .finally(() => {
        if (this.pendingEnd === pendingEnd) this.pendingEnd = null;
      });
    this.pendingEnd = pendingEnd;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private clearStableTimer(): void {
    if (this.stableTimer !== null) window.clearTimeout(this.stableTimer);
    this.stableTimer = null;
  }

  private update(patch: Partial<SessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener(this.snapshot));
  }
}
