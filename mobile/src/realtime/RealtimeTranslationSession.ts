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
import type { PcmAudioFrame } from '../audio/PcmFramePipeline';
import {
  ClientVadPipeline,
  DISABLED_VAD_SNAPSHOT,
  INITIAL_SILERO_VAD_SNAPSHOT,
  SileroVadRuntime,
  type VadDecision,
  type VadGateEvent,
  type VadRuntime,
} from '../audio/VADClient';
import { parseSocketMessage } from './resultParser';
import { applyResultEvent } from './transcriptReducer';
import type { SessionSnapshot } from './types';

const RECONNECT_DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000];
const SOCKET_OPEN_TIMEOUT = 10_000;
type Listener = (snapshot: SessionSnapshot) => void;
type NativeWebSocketConstructor = new (
  url: string,
  protocols?: string | string[] | null,
  options?: { headers?: Record<string, string> },
) => WebSocket;

export class RealtimeTranslationSession {
  private snapshot: SessionSnapshot = { phase: 'idle', conversationId: null, resultConnection: 'closed', audioConnection: 'closed', rows: [], error: null, vad: DISABLED_VAD_SNAPSHOT };
  private listeners = new Set<Listener>();
  private resultSocket: WebSocket | null = null;
  private audioSocket: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private intentionalClose = false;
  private generation = 0;
  private sampleCursor = 0;
  private statusSequence = 0;
  private desiredPaused = false;
  private reconnectPreparation: Promise<void> | null = null;
  private lifecycleQueue: Promise<void> = Promise.resolve();
  private clientVad = false;
  private lastVadUiUpdate = 0;
  private failing = false;
  private readonly vadRuntime: VadRuntime;
  private readonly vadPipeline: ClientVadPipeline;

  constructor(
    private readonly endpoints: RealtimeEndpoints,
    private readonly microphone: MicrophoneRecorder,
    private readonly accessToken: string,
    vadRuntime: VadRuntime = new SileroVadRuntime(),
  ) {
    this.vadRuntime = vadRuntime;
    this.vadPipeline = new ClientVadPipeline(vadRuntime, {
      onDecision: (decision) => this.updateVadSnapshot(decision),
      onOutput: (frame, decision, sampleStart) => this.sendVadAudioFrame(frame, decision, sampleStart),
      onFatal: (error) => this.failActiveSession(error.message),
    });
  }

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
    this.failing = false;
    this.reconnectAttempt = 0;
    this.sampleCursor = 0;
    this.statusSequence = 0;
    this.desiredPaused = false;
    this.clientVad = input.clientVad;
    this.lastVadUiUpdate = 0;
    this.vadPipeline.reset(0);
    this.update({
      phase: 'creating',
      rows: [],
      error: null,
      conversationId: null,
      vad: input.clientVad ? INITIAL_SILERO_VAD_SNAPSHOT : DISABLED_VAD_SNAPSHOT,
    });
    try {
      await Promise.all([
        this.microphone.prepare(),
        input.clientVad ? this.vadRuntime.initialize() : Promise.resolve(),
      ]);
      if (generation !== this.generation) return;
      if (input.clientVad) {
        this.update({ vad: { ...INITIAL_SILERO_VAD_SNAPSHOT, ready: true } });
      }
      const conversationId = await createConversation(this.endpoints, this.accessToken);
      if (generation !== this.generation) {
        await endConversation(this.endpoints, this.accessToken, conversationId).catch(() => {});
        return;
      }
      this.update({ phase: 'configuring', conversationId });
      await saveInterpretationSettings(this.endpoints, this.accessToken, conversationId, input.sourceLanguage, input.targetLanguage, input.clientVad);
      if (generation !== this.generation) return;
      this.update({ phase: 'connecting' });
      await this.connectSockets(conversationId, generation, false);
      if (generation !== this.generation) return;
      this.sendAudioStatus('capturing');
      this.update({ phase: 'recording' });
      await this.microphone.start(
        (frame) => this.handleAudioFrame(frame),
        (error) => {
          if (generation === this.generation && !this.intentionalClose) {
            this.failActiveSession(error.message);
          }
        },
      );
      if (generation !== this.generation) return;
    } catch (error) {
      if (generation !== this.generation) return;
      await this.cleanupLocal();
      const conversationId = this.snapshot.conversationId;
      if (conversationId) await endConversation(this.endpoints, this.accessToken, conversationId).catch(() => {});
      this.update({ phase: 'error', resultConnection: 'closed', audioConnection: 'closed', error: error instanceof Error ? error.message : String(error) });
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
    this.desiredPaused = true;
    try {
      await this.microphone.pause();
      if (generation !== this.generation || this.snapshot.phase !== 'recording') return;
      if (this.clientVad) {
        await this.vadPipeline.drain();
        if (generation !== this.generation || this.snapshot.phase !== 'recording') return;
        this.closeOpenVadGate('capturing');
        this.vadPipeline.reset(this.sampleCursor);
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
      this.vadPipeline.reset(this.sampleCursor);
      this.update({ vad: { ...INITIAL_SILERO_VAD_SNAPSHOT, ready: true } });
    }
    this.sendAudioStatus('capturing');
    this.update({ phase: 'recording' });
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
    if (['idle', 'ended', 'stopping'].includes(this.snapshot.phase)) return;
    ++this.generation;
    this.intentionalClose = true;
    this.clearReconnectTimer();
    this.update({ phase: 'stopping' });
    await this.microphone.pause().catch(() => {});
    if (this.clientVad) {
      await this.vadPipeline.drain().catch(() => {});
      this.closeOpenVadGate('capturing');
    }
    this.sendAudioStatus('idle');
    const conversationId = this.snapshot.conversationId;
    await this.cleanupLocal();
    try {
      if (conversationId && this.accessToken) await endConversation(this.endpoints, this.accessToken, conversationId);
      this.update({ phase: 'ended', resultConnection: 'closed', audioConnection: 'closed' });
    } catch (error) {
      this.update({ phase: 'error', resultConnection: 'closed', audioConnection: 'closed', error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async connectSockets(conversationId: string, generation: number, resetVadRuntime = true): Promise<void> {
    this.update({ resultConnection: 'connecting', audioConnection: 'connecting' });
    const resultSocket = this.createSocket(buildResultWebSocketUrl(this.endpoints, conversationId));
    resultSocket.onmessage = (event) => this.handleResultMessage(event.data);
    await this.waitForOpen(resultSocket);
    if (generation !== this.generation) { resultSocket.close(); return; }
    this.resultSocket = resultSocket;
    this.update({ resultConnection: 'open' });
    resultSocket.onclose = (event) => this.handleSocketClose('result', event);
    resultSocket.onerror = () => this.update({ resultConnection: 'error' });
    const audioSocket = this.createSocket(buildAudioWebSocketUrl(this.endpoints, conversationId));
    audioSocket.binaryType = 'arraybuffer';
    await this.waitForOpen(audioSocket);
    if (generation !== this.generation) { audioSocket.close(); return; }
    this.audioSocket = audioSocket;
    this.sampleCursor = 0;
    if (this.clientVad) {
      this.vadPipeline.reset(0, resetVadRuntime);
      this.update({ vad: { ...INITIAL_SILERO_VAD_SNAPSHOT, ready: true } });
    }
    this.update({ audioConnection: 'open' });
    audioSocket.onclose = (event) => this.handleSocketClose('audio', event);
    audioSocket.onerror = () => this.update({ audioConnection: 'error' });
  }

  private createSocket(url: string): WebSocket {
    const NativeWebSocket = WebSocket as unknown as NativeWebSocketConstructor;
    return new NativeWebSocket(url, null, { headers: { Origin: this.endpoints.appOrigin } });
  }
  private waitForOpen(socket: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { socket.close(); reject(new Error('WebSocket connection timed out.')); }, SOCKET_OPEN_TIMEOUT);
      socket.onopen = () => { clearTimeout(timeout); resolve(); };
      socket.onerror = () => { clearTimeout(timeout); reject(new Error('WebSocket connection failed.')); };
    });
  }
  private handleResultMessage(raw: unknown): void {
    const parsed = parseSocketMessage(raw);
    if (parsed.kind === 'result') this.update({ rows: applyResultEvent(this.snapshot.rows, parsed.event) });
    else if (parsed.kind === 'error') this.update({ error: parsed.message });
    else if (parsed.kind === 'ended') {
      this.intentionalClose = true;
      ++this.generation;
      void this.cleanupLocal().then(() => this.update({ phase: 'ended', resultConnection: 'closed', audioConnection: 'closed' }));
    }
  }
  private handleSocketClose(kind: 'result' | 'audio', event: { code?: number; reason?: string }): void {
    this.update(kind === 'result' ? { resultConnection: 'closed' } : { audioConnection: 'closed' });
    if (this.intentionalClose || !['recording', 'paused', 'reconnecting'].includes(this.snapshot.phase)) return;
    if (event.code === 1000 || event.code === 1008) {
      this.failActiveSession(event.reason || `WebSocket closed. (${event.code})`);
      return;
    }
    this.scheduleReconnect();
  }
  private scheduleReconnect(): void {
    if (this.intentionalClose || this.reconnectTimer || !this.snapshot.conversationId) return;
    const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    this.reconnectAttempt += 1;
    this.update({ phase: 'reconnecting' });
    this.reconnectPreparation = this.prepareForReconnect();
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; void this.reconnect(); }, delay);
  }
  private async reconnect(): Promise<void> {
    const conversationId = this.snapshot.conversationId;
    if (!conversationId || this.intentionalClose) return;
    const generation = ++this.generation;
    await this.reconnectPreparation?.catch(() => {});
    this.reconnectPreparation = null;
    if (this.intentionalClose || generation !== this.generation) return;
    this.closeSockets();
    try {
      await this.connectSockets(conversationId, generation);
      if (this.intentionalClose || generation !== this.generation) {
        this.closeSockets();
        return;
      }
      this.reconnectAttempt = 0;
      this.sendAudioStatus(this.desiredPaused ? 'paused' : 'capturing');
      this.update({ phase: this.desiredPaused ? 'paused' : 'recording', error: null });
      if (!this.desiredPaused) {
        await this.microphone.resume();
        if (this.intentionalClose || generation !== this.generation || this.snapshot.phase !== 'recording') {
          await this.microphone.pause().catch(() => {});
        }
      }
    } catch (error) {
      if (this.intentionalClose || generation !== this.generation) return;
      this.update({ error: error instanceof Error ? error.message : String(error) });
      this.scheduleReconnect();
    }
  }
  private handleAudioFrame(frame: PcmAudioFrame): void {
    if (this.snapshot.phase !== 'recording' || this.audioSocket?.readyState !== WebSocket.OPEN) return;
    if (this.clientVad) this.vadPipeline.enqueue(frame);
    else this.sendAudioFrame(frame.pcm16, frame.sampleCount);
  }
  private sendAudioFrame(frame: ArrayBuffer, sampleCount: number): void {
    if (this.snapshot.phase !== 'recording' || this.audioSocket?.readyState !== WebSocket.OPEN) return;
    this.audioSocket.send(frame);
    this.sampleCursor += sampleCount;
  }
  private sendVadAudioFrame(frame: PcmAudioFrame, decision: VadDecision, sampleStart: number): void {
    if (!['recording', 'stopping'].includes(this.snapshot.phase) || this.audioSocket?.readyState !== WebSocket.OPEN) return;
    if (sampleStart !== this.sampleCursor) {
      this.failActiveSession('VAD audio sample cursor mismatch.');
      return;
    }
    if (decision.event) this.sendAudioStatus('capturing', decision, decision.event, sampleStart);
    if (this.audioSocket?.readyState !== WebSocket.OPEN || !['recording', 'stopping'].includes(this.snapshot.phase)) return;
    this.audioSocket.send(frame.pcm16);
    this.sampleCursor = sampleStart + frame.sampleCount;
  }
  private sendAudioStatus(
    state: 'capturing' | 'paused' | 'idle',
    decision?: VadDecision,
    event?: VadGateEvent,
    sample = this.sampleCursor,
  ): void {
    if (this.audioSocket?.readyState !== WebSocket.OPEN) return;
    this.statusSequence += 1;
    const vad = {
      enabled: decision?.enabled ?? this.clientVad,
      ...(event ? { event } : {}),
    };
    this.audioSocket.send(JSON.stringify({ type: 'audio.status', version: 1, status_seq: this.statusSequence, boundary_sample: sample, mic: { state }, vad }));
  }
  private async cleanupLocal(): Promise<void> {
    this.clearReconnectTimer();
    this.vadPipeline.reset(this.sampleCursor);
    await this.microphone.stop().catch(() => {});
    this.closeSockets();
    await this.vadPipeline.drain().catch(() => {});
    if (this.clientVad) await this.vadRuntime.dispose().catch(() => {});
  }
  private enqueueLifecycle(operation: () => Promise<void>): Promise<void> {
    const result = this.lifecycleQueue.then(operation);
    this.lifecycleQueue = result.catch(() => {});
    return result;
  }
  private async prepareForReconnect(): Promise<void> {
    await this.microphone.pause().catch(() => {});
    if (this.clientVad) {
      if (this.audioSocket?.readyState === WebSocket.OPEN) {
        this.closeOpenVadGate('capturing');
        this.sendAudioStatus('paused');
      }
      // The stream is discontinuous. Cancel queued inference rather than attaching old PCM to the new socket.
      this.vadPipeline.reset(0);
      this.update({ vad: { ...INITIAL_SILERO_VAD_SNAPSHOT, ready: true } });
    }
  }
  private closeOpenVadGate(micState: 'capturing' | 'paused'): void {
    if (!this.clientVad || this.snapshot.vad.gate !== 'open') return;
    const decision: VadDecision = {
      ...this.snapshot.vad,
      gate: 'closed',
      probability: 0,
      isSpeech: false,
      level: 'off',
      rms: 0,
      event: 'speech_gate_closed',
    };
    this.sendAudioStatus(micState, decision, decision.event, this.sampleCursor);
    this.updateVadSnapshot(decision);
  }
  private failActiveSession(message: string): void {
    if (this.failing) return;
    this.failing = true;
    this.intentionalClose = true;
    ++this.generation;
    const conversationId = this.snapshot.conversationId;
    void this.cleanupLocal().then(async () => {
      if (conversationId && this.accessToken) {
        await endConversation(this.endpoints, this.accessToken, conversationId).catch(() => {});
      }
      this.update({ phase: 'error', resultConnection: 'closed', audioConnection: 'closed', error: message });
    });
  }
  private closeSockets(): void {
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
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
  private updateVadSnapshot(decision: VadDecision): void {
    const now = Date.now();
    if (!decision.event && now - this.lastVadUiUpdate < 100) return;
    this.lastVadUiUpdate = now;
    const { rms: _rms, event: _event, ...vad } = decision;
    this.update({ vad });
  }
  private update(patch: Partial<SessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener(this.snapshot));
  }
}
