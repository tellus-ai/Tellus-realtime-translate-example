import {
  attachEngineAuthorization,
  type AuthorizableAudioCapture,
  type EngineAuthorizationController,
} from '@tellus-ai/audio-sdk/authorization';
import type { RealtimeApi } from '../realtimeApi';
import type { StartConversationInput } from '../shared/desktopApi';
import type { ClientVadSnapshot, SessionSnapshot, VadEvent, VadGate } from '../shared/realtimeTypes';
import { parseSocketMessage } from './resultParser';
import { applyResultEvent } from './transcriptReducer';
import {
  buildAudioStatusMessage,
  disabledVadSnapshot,
  resolveVadLevel,
  sileroVadSnapshot,
  type MicrophoneState,
} from './VADAudioStatus';

const RECONNECT_DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000];
const SOCKET_OPEN_TIMEOUT = 10_000;
// The audio engine encodes 20 ms Opus frames at 16 kHz (see audio/audioEngine.ts).
const AUDIO_FORMAT = 'opus';

type Listener = (snapshot: SessionSnapshot) => void;

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
  private resultSocket: WebSocket | null = null;
  private audioSocket: WebSocket | null = null;
  private capture: MicrophoneCapture | null = null;
  private authorization: EngineAuthorizationController | null = null;
  private captureStarted = false;
  private reconnectAttempt = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private intentionalClose = false;
  private failing = false;
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
    private readonly createSocket: (url: string) => WebSocket = (url) => new WebSocket(url),
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

  async start(input: StartConversationInput): Promise<void> {
    if (this.isActive()) return;
    if (input.sourceLanguage === input.targetLanguage) {
      this.update({ error: 'Select two different languages.' });
      return;
    }

    const generation = ++this.generation;
    this.intentionalClose = false;
    this.failing = false;
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
      await this.connectSockets(conversationId, generation);
      if (generation !== this.generation) return;

      // The initial status always precedes the first audio frame.
      this.sendAudioStatus('capturing', this.snapshot.vad);
      this.acceptingAudio = true;
      this.update({ phase: 'recording' });
      this.startCapture();
    } catch (error) {
      if (generation !== this.generation) return;
      this.cleanupLocal();
      const conversationId = this.snapshot.conversationId;
      if (conversationId) {
        await this.api.endConversation(conversationId).catch(() => {});
      }
      this.update({
        phase: 'error',
        resultConnection: 'closed',
        audioConnection: 'closed',
        error: error instanceof Error ? error.message : String(error),
      });
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
    if (this.snapshot.phase !== 'paused') return;
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

  private async stopNow(): Promise<void> {
    if (['idle', 'ended', 'stopping'].includes(this.snapshot.phase)) return;
    this.intentionalClose = true;
    this.acceptingAudio = false;
    this.clearReconnectTimer();
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
    this.cleanupLocal();
    try {
      if (conversationId) {
        await this.api.endConversation(conversationId);
      }
      this.update({
        phase: 'ended',
        resultConnection: 'closed',
        audioConnection: 'closed',
        vad: disabledVadSnapshot(false),
      });
    } catch (error) {
      this.update({
        phase: 'error',
        resultConnection: 'closed',
        audioConnection: 'closed',
        error: error instanceof Error ? error.message : String(error),
      });
    }
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

  private async connectSockets(conversationId: string, generation: number): Promise<void> {
    this.update({ resultConnection: 'connecting', audioConnection: 'connecting' });
    const resultSocket = this.createSocket(
      `${this.endpoints.websocketBaseUrl}/conversations/${encodeURIComponent(conversationId)}/results`,
    );
    resultSocket.onmessage = (event) => this.handleResultMessage(event.data);
    await this.waitForOpen(resultSocket);
    if (generation !== this.generation) {
      resultSocket.close();
      return;
    }
    this.resultSocket = resultSocket;
    this.update({ resultConnection: 'open' });
    resultSocket.onclose = (event) => this.handleSocketClose('result', event);
    resultSocket.onerror = () => this.update({ resultConnection: 'error' });

    const id = encodeURIComponent(conversationId);
    const audioSocket = this.createSocket(
      `${this.endpoints.websocketBaseUrl}/audio?conversation_id=${id}&audio_format=${AUDIO_FORMAT}`,
    );
    await this.waitForOpen(audioSocket);
    if (generation !== this.generation) {
      audioSocket.close();
      return;
    }
    // Each Audio WebSocket counts samples from zero; status_seq keeps increasing for the conversation.
    this.audioSocket = audioSocket;
    this.sampleCursor = 0;
    this.socketGate = 'closed';
    this.update({ audioConnection: 'open' });
    audioSocket.onclose = (event) => this.handleSocketClose('audio', event);
    audioSocket.onerror = () => this.update({ audioConnection: 'error' });
    const capture = this.capture;
    if (!capture) throw new Error('Audio capture is unavailable.');
    const authorization = attachEngineAuthorization(audioSocket, capture, {
      conversationId,
      getAccessToken: this.getAccessToken,
      onError: (error) => {
        if (generation === this.generation && audioSocket === this.audioSocket && !this.intentionalClose) {
          if (['engine_authorization_connection_closed', 'engine_authorization_connection_failed'].includes(error.message)) {
            this.scheduleReconnect();
          } else {
            this.failActiveSession(error.message);
          }
        }
      },
    });
    this.authorization = authorization;
    await authorization.ready;
  }

  private startCapture(): void {
    const capture = this.capture;
    if (!capture) throw new Error('Audio capture is unavailable.');
    capture.start((error, chunk) => this.handleChunk(capture, error, chunk));
    this.captureStarted = true;
  }

  private waitForOpen(socket: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        socket.close();
        reject(new Error('WebSocket connection timed out.'));
      }, SOCKET_OPEN_TIMEOUT);
      socket.onopen = () => {
        clearTimeout(timeout);
        resolve();
      };
      socket.onerror = () => {
        clearTimeout(timeout);
        reject(new Error('WebSocket connection failed.'));
      };
    });
  }

  private handleResultMessage(raw: unknown): void {
    const parsed = parseSocketMessage(raw);
    if (parsed.kind === 'result') {
      this.update({ rows: applyResultEvent(this.snapshot.rows, parsed.event) });
    } else if (parsed.kind === 'error') {
      this.update({ error: parsed.message });
    } else if (parsed.kind === 'ended') {
      this.intentionalClose = true;
      this.acceptingAudio = false;
      ++this.generation;
      this.cleanupLocal();
      this.update({
        phase: 'ended',
        resultConnection: 'closed',
        audioConnection: 'closed',
        vad: disabledVadSnapshot(false),
      });
    }
  }

  private handleSocketClose(kind: 'result' | 'audio', event: CloseEvent): void {
    this.update(kind === 'result' ? { resultConnection: 'closed' } : { audioConnection: 'closed' });
    if (this.intentionalClose) return;
    const reason = event.reason || this.snapshot.error || `WebSocket closed. (${event.code})`;
    // A socket closed while the other one is still connecting means the start itself failed.
    if (this.snapshot.phase === 'connecting') {
      this.failActiveSession(reason);
      return;
    }
    if (!['recording', 'paused', 'reconnecting'].includes(this.snapshot.phase)) return;
    if (event.code === 1000 || event.code === 1008) {
      this.failActiveSession(reason);
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose || this.reconnectTimer !== null || !this.snapshot.conversationId) return;
    const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    this.reconnectAttempt += 1;
    this.acceptingAudio = false;
    this.closeSockets();
    // Disposing authorization stops native capture. Reconnect must authorize and start it again.
    this.engineGate = 'closed';
    this.update({ phase: 'reconnecting', vad: this.idleVadSnapshot() });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, delay);
  }

  private async reconnect(): Promise<void> {
    const conversationId = this.snapshot.conversationId;
    if (!conversationId || this.intentionalClose) return;
    const generation = ++this.generation;
    try {
      await this.connectSockets(conversationId, generation);
      if (this.intentionalClose || generation !== this.generation) {
        this.closeSockets();
        return;
      }
      this.reconnectAttempt = 0;
      const state = this.desiredPaused ? 'paused' : 'capturing';
      this.sendAudioStatus(state, this.snapshot.vad);
      this.update({ phase: this.desiredPaused ? 'paused' : 'recording', error: null });
      if (!this.desiredPaused) {
        this.acceptingAudio = true;
        this.startCapture();
      }
    } catch (error) {
      this.acceptingAudio = false;
      if (this.intentionalClose || generation !== this.generation) return;
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('engine_') && ![
        'engine_authorization_connection_closed', 'engine_authorization_connection_failed', 'engine_authorization_timeout',
      ].includes(message)) {
        this.failActiveSession(message);
        return;
      }
      this.update({ error: message });
      this.scheduleReconnect();
    }
  }

  private sendAudioFrame(frame: Uint8Array, sampleCount: number): void {
    if (this.snapshot.phase !== 'recording' || this.audioSocket?.readyState !== WebSocket.OPEN) return;
    // Engine payloads are Node Buffers, which are never backed by shared memory.
    this.audioSocket.send(frame as Uint8Array<ArrayBuffer>);
    this.sampleCursor += sampleCount;
  }

  private sendAudioStatus(state: MicrophoneState, vad: ClientVadSnapshot, event?: VadEvent): void {
    if (this.audioSocket?.readyState !== WebSocket.OPEN) return;
    this.statusSequence += 1;
    this.audioSocket.send(JSON.stringify(buildAudioStatusMessage({
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

  private cleanupLocal(): void {
    this.acceptingAudio = false;
    this.clearReconnectTimer();
    const capture = this.capture;
    this.capture = null;
    try {
      capture?.stop();
    } catch {
      // The native capture is released either way.
    }
    this.closeSockets();
  }

  private failActiveSession(message: string): void {
    if (this.failing) return;
    this.failing = true;
    this.intentionalClose = true;
    this.acceptingAudio = false;
    ++this.generation;
    const conversationId = this.snapshot.conversationId;
    this.cleanupLocal();
    void (async () => {
      if (conversationId) {
        await this.api.endConversation(conversationId).catch(() => {});
      }
      this.update({
        phase: 'error',
        resultConnection: 'closed',
        audioConnection: 'closed',
        error: message,
      });
    })();
  }

  private closeSockets(): void {
    this.authorization?.dispose();
    this.authorization = null;
    this.captureStarted = false;
    for (const socket of [this.audioSocket, this.resultSocket]) {
      if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
        socket.onclose = null;
        socket.close(1000);
      }
    }
    this.audioSocket = null;
    this.resultSocket = null;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
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
