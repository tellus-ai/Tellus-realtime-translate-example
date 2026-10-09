import { AudioEngine, type AudioCapture, type AudioChunk } from '@tellus-ai/audio-sdk-web';
import { attachEngineAuthorization, type EngineAuthorizationController } from '@tellus-ai/audio-sdk-web/authorization';
import { browserEngineAssets } from '../config/browserEngineAssets';

export interface MicrophoneRecorder {
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

  async prepare(clientVad: boolean): Promise<void> {
    await this.stop();
    this.engine = await AudioEngine.init({
      micEnabled: true, processing: { sampleRate: 16000, chunkDurationMs: 20 },
      transport: { codec: 'opus', bitrateBps: 64000 },
      vadEnabled: clientVad, denoiseEnabled: import.meta.env.VITE_TELLUS_DENOISE === 'true',
      echoCancellationEnabled: true, micAgc2Enabled: false,
    }, browserEngineAssets(clientVad));
    this.capture = this.engine.createCapture();
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
    try { await this.capture?.stop(); }
    finally {
      this.releaseAuthorization();
      await this.engine?.dispose();
      this.capture = undefined;
      this.engine = undefined;
      this.callback = undefined;
    }
  }
}
