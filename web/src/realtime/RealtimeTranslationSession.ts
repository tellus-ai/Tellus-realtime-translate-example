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
import { parseSocketMessage } from './resultParser';
import { applyResultEvent } from './transcriptReducer';
import type { SessionSnapshot } from './types';

const RECONNECT_DELAYS = [1_000, 2_000, 5_000, 10_000, 30_000];
const SOCKET_OPEN_TIMEOUT = 10_000;
const MAX_PENDING_AUDIO_FRAMES = 10;

type Listener = (snapshot: SessionSnapshot) => void;
type VadProcessorFactory = () => ClientVadProcessor;

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
  private resultSocket: WebSocket | null = null;
  private audioSocket: WebSocket | null = null;
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;
  private reconnectPreparation: Promise<void> | null = null;
  private intentionalClose = false;
  private failing = false;
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
    this.failing = false;
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
      await this.connectSockets(conversationId, generation);
      if (generation !== this.generation) return;

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
      this.acceptingAudio = false;
      await this.cleanupLocal();
      const conversationId = this.snapshot.conversationId;
      if (conversationId) {
        await endConversation(this.endpoints, this.accessToken, conversationId).catch(() => {});
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
      await this.microphone.pause();
      await this.drainAudioQueue();
      const event = this.snapshot.vad.enabled && this.snapshot.vad.gate === 'open'
        ? 'speech_gate_closed' as const
        : undefined;
      const vad = this.snapshot.vad.enabled ? sileroVadSnapshot(true) : this.snapshot.vad;
      if (this.vadProcessor) await this.vadProcessor.reset();
      if (event) this.sendAudioStatus('capturing', vad, event);
      this.sendAudioStatus('paused', vad);
      this.update({ phase: 'paused', vad });
    } catch (error) {
      this.failActiveSession(error instanceof Error ? error.message : String(error));
    }
  }

  private async resumeNow(): Promise<void> {
    if (this.snapshot.phase !== 'paused') return;
    try {
      if (this.vadProcessor) await this.vadProcessor.reset();
      const vad = this.snapshot.vad.enabled ? sileroVadSnapshot(true) : this.snapshot.vad;
      this.desiredPaused = false;
      this.sendAudioStatus('capturing', vad);
      this.update({ phase: 'recording', vad });
      this.acceptingAudio = true;
      await this.microphone.resume();
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
    await this.cleanupLocal();
    try {
      if (conversationId && this.accessToken) {
        await endConversation(this.endpoints, this.accessToken, conversationId);
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

  private async connectSockets(conversationId: string, generation: number): Promise<void> {
    this.update({ resultConnection: 'connecting', audioConnection: 'connecting' });
    const resultSocket = this.createSocket(buildResultWebSocketUrl(this.endpoints, conversationId));
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

    const audioSocket = this.createSocket(
      buildAudioWebSocketUrl(this.endpoints, conversationId, this.audioFormat),
    );
    audioSocket.binaryType = 'arraybuffer';
    await this.waitForOpen(audioSocket);
    if (generation !== this.generation) {
      audioSocket.close();
      return;
    }
    this.audioSocket = audioSocket;
    this.update({ audioConnection: 'open' });
    audioSocket.onclose = (event) => this.handleSocketClose('audio', event);
    audioSocket.onerror = () => this.update({ audioConnection: 'error' });
  }

  private createSocket(url: string): WebSocket {
    return new WebSocket(url);
  }

  private waitForOpen(socket: WebSocket): Promise<void> {
    return new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        socket.close();
        reject(new Error('WebSocket connection timed out.'));
      }, SOCKET_OPEN_TIMEOUT);
      socket.onopen = () => {
        window.clearTimeout(timeout);
        resolve();
      };
      socket.onerror = () => {
        window.clearTimeout(timeout);
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
      this.audioEpoch += 1;
      void this.cleanupLocal().then(() => {
        this.update({
          phase: 'ended',
          resultConnection: 'closed',
          audioConnection: 'closed',
          vad: disabledVadSnapshot(false),
        });
      });
    }
  }

  private handleSocketClose(kind: 'result' | 'audio', event: CloseEvent): void {
    this.update(kind === 'result' ? { resultConnection: 'closed' } : { audioConnection: 'closed' });
    if (this.intentionalClose || !['recording', 'paused', 'reconnecting'].includes(this.snapshot.phase)) return;
    if (event.code === 1000 || event.code === 1008) {
      this.failActiveSession(event.reason || `WebSocket closed. (${event.code})`);
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.intentionalClose || this.reconnectTimer !== null || !this.snapshot.conversationId) return;
    const delay = RECONNECT_DELAYS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS.length - 1)];
    this.reconnectAttempt += 1;
    this.acceptingAudio = false;
    this.update({ phase: 'reconnecting' });
    this.reconnectPreparation ??= this.prepareForReconnect().catch((error) => {
      if (!this.intentionalClose) {
        this.failActiveSession(error instanceof Error ? error.message : String(error));
      }
    });
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      void this.reconnect();
    }, delay);
  }

  private async prepareForReconnect(): Promise<void> {
    this.audioEpoch += 1;
    this.closeSockets();
    await this.microphone.pause().catch(() => {});
    await this.drainAudioQueue();
    if (this.vadProcessor) await this.vadProcessor.reset();
    if (this.opusEncoder) await this.opusEncoder.reset();
    if (this.intentionalClose) return;
    const vad = this.snapshot.vad.enabled ? sileroVadSnapshot(true) : this.snapshot.vad;
    this.update({ vad });
  }

  private async reconnect(): Promise<void> {
    const conversationId = this.snapshot.conversationId;
    if (!conversationId || this.intentionalClose) return;
    const generation = ++this.generation;
    try {
      await this.reconnectPreparation;
      this.reconnectPreparation = null;
      if (this.intentionalClose || generation !== this.generation) return;
      this.sampleCursor = 0;
      this.nextFrameSample = 0;
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
        await this.microphone.resume();
        if (this.intentionalClose || generation !== this.generation) {
          this.acceptingAudio = false;
          await this.microphone.pause().catch(() => {});
          return;
        }
      }
    } catch (error) {
      this.acceptingAudio = false;
      this.reconnectPreparation = null;
      if (this.intentionalClose || generation !== this.generation) return;
      this.update({ error: error instanceof Error ? error.message : String(error) });
      this.scheduleReconnect();
    }
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
    if (this.snapshot.phase !== 'recording' || this.audioSocket?.readyState !== WebSocket.OPEN) return;
    if (sampleStart !== this.sampleCursor) {
      this.failActiveSession(`Audio sample cursor mismatch: ${sampleStart} != ${this.sampleCursor}`);
      return;
    }
    this.audioSocket.send(frame);
    this.sampleCursor += sampleCount;
  }

  private sendAudioStatus(
    state: MicrophoneState,
    vad: ClientVadSnapshot,
    event?: VadEvent,
    sample = this.sampleCursor,
  ): void {
    if (this.audioSocket?.readyState !== WebSocket.OPEN) return;
    this.statusSequence += 1;
    this.audioSocket.send(JSON.stringify(buildAudioStatusMessage({
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

  private async cleanupLocal(): Promise<void> {
    this.acceptingAudio = false;
    this.clearReconnectTimer();
    this.reconnectPreparation = null;
    await this.microphone.stop().catch(() => {});
    await this.vadProcessor?.dispose().catch(() => {});
    this.vadProcessor = null;
    await this.opusEncoder?.dispose().catch(() => {});
    this.opusEncoder = null;
    this.closeSockets();
  }

  private failActiveSession(message: string): void {
    if (this.failing) return;
    this.failing = true;
    this.intentionalClose = true;
    this.acceptingAudio = false;
    ++this.generation;
    this.audioEpoch += 1;
    const conversationId = this.snapshot.conversationId;
    void this.cleanupLocal().then(async () => {
      if (conversationId && this.accessToken) {
        await endConversation(this.endpoints, this.accessToken, conversationId).catch(() => {});
      }
      this.update({
        phase: 'error',
        resultConnection: 'closed',
        audioConnection: 'closed',
        error: message,
      });
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
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private update(patch: Partial<SessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach((listener) => listener(this.snapshot));
  }
}
