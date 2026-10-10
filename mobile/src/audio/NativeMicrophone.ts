import type { AudioCapture, AudioChunk } from '@tellus-ai/audio-sdk-mobile';
import { attachEngineAuthorization, type EngineAuthorizationController } from '@tellus-ai/audio-sdk-mobile/authorization';

export interface MicrophoneRecorder {
  readonly audioSdkReady: boolean;
  prepare(clientVad: boolean): Promise<void>;
  authorize(socket: WebSocket, conversationId: string, accessToken: string, onError: (error: Error) => void): Promise<void>;
  releaseAuthorization(): void;
  start(onFrame: (frame: AudioChunk) => void, onError: (error: Error) => void): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
}

/** OS 마이크·DSP·VAD·인코더는 SDK capture가 소유한다. 앱은 전송 payload만 전달한다. */
export class NativeMicrophone implements MicrophoneRecorder {
  private capture?: AudioCapture;
  private authorization?: EngineAuthorizationController;
  private callback?: Parameters<AudioCapture['start']>[0];
  private generation = 0;

  get audioSdkReady(): boolean { return Boolean(this.capture); }

  async prepare(_clientVad: boolean): Promise<void> {
    await this.stop();
    const generation = ++this.generation;
    try {
      // Load the native module here so an unavailable SDK becomes a visible session error.
      const { AudioEngine } = require('@tellus-ai/audio-sdk-mobile') as typeof import('@tellus-ai/audio-sdk-mobile');
      const engine = await AudioEngine.init({
        micEnabled: true, processing: { sampleRate: 16000, chunkDurationMs: 20 },
        transport: { codec: 'opus', bitrateBps: 64000 },
        denoiseEnabled: process.env.EXPO_PUBLIC_TELLUS_DENOISE !== 'false', vadEnabled: false,
        echoCancellationEnabled: true, micAgc2Enabled: false,
      });
      if (generation === this.generation) this.capture = engine.createCapture();
    } catch (error) {
      throw new Error(`Audio SDK is required but could not be initialized: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async authorize(socket: WebSocket, conversationId: string, accessToken: string, onError: (error: Error) => void): Promise<void> {
    if (!this.capture) throw new Error('Audio capture is unavailable.');
    this.releaseAuthorization();
    this.authorization = attachEngineAuthorization(socket, this.capture, {
      conversationId, getAccessToken: () => accessToken, onError,
    });
    await this.authorization.ready;
  }

  releaseAuthorization(): void {
    this.authorization?.dispose();
    this.authorization = undefined;
  }

  async start(onFrame: (frame: AudioChunk) => void, onError: (error: Error) => void): Promise<void> {
    if (!this.capture) throw new Error('Audio capture is unavailable.');
    this.callback = (error, chunk) => { if (error) onError(error); else if (chunk) onFrame(chunk); };
    await this.capture.start(this.callback);
  }

  async pause(): Promise<void> { await this.capture?.pause(); }

  async resume(): Promise<void> {
    if (!this.capture || !this.callback) throw new Error('Unable to resume the microphone stream.');
    const status = await this.capture.getStatus();
    if (status.state === 'stopped') await this.capture.start(this.callback);
    else await this.capture.resume();
  }

  async stop(): Promise<void> {
    ++this.generation;
    const capture = this.capture;
    this.capture = undefined;
    try {
      const status = await capture?.getStatus();
      if (status?.state === 'running' || status?.state === 'paused') await capture?.stop();
    }
    finally {
      this.releaseAuthorization();
      await capture?.dispose();
      this.callback = undefined;
    }
  }
}
