import type { AudioEngine, AudioCapture, AudioChunk } from '@tellus-ai/audio-sdk-web';
import { attachEngineAuthorization, type EngineAuthorizationController } from '@tellus-ai/audio-sdk-web/authorization';
import { browserEngineAssets } from '../config/browserEngineAssets';

export interface MicrophoneRecorder {
  readonly audioSdkReady: boolean;
  readonly denoiseEnabled: boolean;
  setDenoiseEnabled(enabled: boolean): Promise<boolean>;
  prepare(clientVad: boolean): Promise<void>;
  authorize(socket: WebSocket, conversationId: string, accessToken: string, onError: (error: Error) => void): Promise<void>;
  releaseAuthorization(): void;
  start(onFrame: (frame: AudioChunk) => void, onError: (error: Error) => void): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
}

/** OS 입력·DSP·VAD·codec을 공통 SDK capture에 위임한다. */
export class BrowserMicrophone implements MicrophoneRecorder {
  private engine?: AudioEngine;
  private capture?: AudioCapture;
  private authorization?: EngineAuthorizationController;
  private callback?: Parameters<AudioCapture['start']>[0];
  private generation = 0;
  private denoise = import.meta.env.VITE_TELLUS_DENOISE === 'true';

  get audioSdkReady(): boolean { return Boolean(this.capture); }
  get denoiseEnabled(): boolean { return this.denoise; }

  async setDenoiseEnabled(enabled: boolean): Promise<boolean> {
    const capture = this.capture;
    if (capture) {
      await capture.setDenoiseEnabled(enabled);
      const status = await capture.getStatus();
      if (capture !== this.capture) return this.denoise;
      this.denoise = status.denoiseEnabled;
      if (this.denoise !== enabled) throw new Error('Audio SDK did not apply the requested denoise setting.');
    } else this.denoise = enabled;
    return this.denoise;
  }

  async prepare(_clientVad: boolean): Promise<void> {
    await this.stop();
    const generation = ++this.generation;
    try {
      const { AudioEngine } = await import('@tellus-ai/audio-sdk-web');
      const engine = await AudioEngine.init({
        micEnabled: true, processing: { sampleRate: 16000, chunkDurationMs: 20 },
        transport: { codec: 'opus', bitrateBps: 64000 },
        vadEnabled: false, denoiseEnabled: this.denoise,
        echoCancellationEnabled: true, micAgc2Enabled: false,
      }, browserEngineAssets(false));
      if (generation !== this.generation) {
        await engine.dispose();
        return;
      }
      this.engine = engine;
      const capture = engine.createCapture();
      this.capture = capture;
      const status = await capture.getStatus();
      if (capture === this.capture) this.denoise = status.denoiseEnabled;
    } catch (error) {
      throw new Error(`Audio SDK is required but could not be initialized: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async authorize(socket: WebSocket, conversationId: string, accessToken: string, onError: (error: Error) => void): Promise<void> {
    if (!this.capture) throw new Error('Audio capture is unavailable.');
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
    this.callback = (error, chunk) => {
      if (error) onError(error);
      else if (chunk) onFrame(chunk);
    };
    await this.capture.start(this.callback);
  }

  async pause(): Promise<void> { await this.capture?.pause(); }

  async resume(): Promise<void> {
    if (!this.capture || !this.callback) throw new Error('Unable to restart the microphone stream.');
    const status = await this.capture.getStatus();
    if (status.state === 'stopped') await this.capture.start(this.callback);
    else await this.capture.resume();
  }

  async stop(): Promise<void> {
    ++this.generation;
    const capture = this.capture;
    const engine = this.engine;
    this.capture = undefined;
    this.engine = undefined;
    this.callback = undefined;
    try { await capture?.stop(); }
    finally {
      this.releaseAuthorization();
      await engine?.dispose();
    }
  }
}
