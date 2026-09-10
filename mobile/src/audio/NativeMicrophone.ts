import { Platform } from 'react-native';
import { AudioManager, AudioRecorder } from 'react-native-audio-api';
import { PERMISSIONS, request, RESULTS } from 'react-native-permissions';
import { PcmFramePipeline, type PcmAudioFrame } from './PcmFramePipeline';

export interface MicrophoneRecorder {
  prepare(): Promise<void>;
  start(
    onFrame: (frame: PcmAudioFrame) => void,
    onError: (error: Error) => void,
  ): Promise<void>;
  pause(): Promise<void>;
  resume(): Promise<void>;
  stop(): Promise<void>;
}

export class NativeMicrophone implements MicrophoneRecorder {
  private recorder: AudioRecorder | null = null;
  private pipeline = new PcmFramePipeline();
  private paused = false;
  private frameHandler: ((frame: PcmAudioFrame) => void) | null = null;
  private errorHandler: ((error: Error) => void) | null = null;
  private callbackGeneration = 0;

  async prepare(): Promise<void> {
    const permission = Platform.OS === 'ios' ? PERMISSIONS.IOS.MICROPHONE : PERMISSIONS.ANDROID.RECORD_AUDIO;
    const status = await request(permission);
    if (status !== RESULTS.GRANTED && status !== RESULTS.LIMITED) {
      throw new Error('Microphone permission is required for realtime translation.');
    }
  }

  async start(
    onFrame: (frame: PcmAudioFrame) => void,
    onError: (error: Error) => void,
  ): Promise<void> {
    await this.prepare();
    AudioManager.setAudioSessionOptions({
      iosCategory: 'playAndRecord',
      iosMode: 'voiceChat',
      iosOptions: ['defaultToSpeaker', 'allowBluetoothHFP'],
    });
    await AudioManager.setAudioSessionActivity(true);

    const recorder = new AudioRecorder();
    this.recorder = recorder;
    this.frameHandler = onFrame;
    this.errorHandler = onError;
    this.paused = false;
    this.pipeline.reset();

    try {
      this.registerAudioReady(recorder);
      let errorReported = false;
      recorder.onError(({ message }) => {
        if (this.recorder !== recorder || errorReported) return;
        errorReported = true;
        this.invalidateAudioReady(recorder);
        recorder.clearOnError();
        this.pipeline.reset();
        this.errorHandler?.(new Error(message || 'An error occurred while recording audio.'));
      });
      const result = await recorder.start();
      if (this.recorder !== recorder) {
        recorder.clearOnAudioReady();
        recorder.clearOnError();
        await recorder.stop().catch(() => {});
        return;
      }
      if (result.status === 'error') {
        throw new Error(result.message || 'Unable to start microphone recording.');
      }
    } catch (error) {
      if (this.recorder === recorder) {
        this.recorder = null;
        this.frameHandler = null;
        this.errorHandler = null;
      }
      this.invalidateAudioReady(recorder);
      recorder.clearOnError();
      await recorder.stop().catch(() => {});
      await AudioManager.setAudioSessionActivity(false).catch(() => {});
      throw error;
    }
  }

  private registerAudioReady(recorder: AudioRecorder): void {
    const generation = ++this.callbackGeneration;
    const registration = recorder.onAudioReady(
      { sampleRate: 16_000, bufferLength: 320, channelCount: 1 },
      (event) => {
        if (this.recorder !== recorder || this.paused || generation !== this.callbackGeneration) return;
        for (const frame of this.pipeline.push(event.buffer.getChannelData(0), event.buffer.sampleRate)) {
          this.frameHandler?.(frame);
        }
      },
    );
    if (registration.status === 'error') {
      recorder.clearOnAudioReady();
      throw new Error(registration.message);
    }
  }

  private invalidateAudioReady(recorder: AudioRecorder): void {
    this.callbackGeneration += 1;
    recorder.clearOnAudioReady();
  }

  async pause(): Promise<void> {
    if (!this.recorder || this.paused) return;
    const recorder = this.recorder;
    this.paused = true;
    this.invalidateAudioReady(recorder);
    this.pipeline.reset();
    try {
      recorder.pause();
    } catch (error) {
      this.paused = false;
      this.registerAudioReady(recorder);
      throw error;
    }
  }

  async resume(): Promise<void> {
    if (!this.recorder || !this.paused) return;
    const recorder = this.recorder;
    this.pipeline.reset();
    this.paused = false;
    try {
      this.registerAudioReady(recorder);
      recorder.resume();
    } catch (error) {
      this.paused = true;
      this.invalidateAudioReady(recorder);
      throw error;
    }
  }

  async stop(): Promise<void> {
    const recorder = this.recorder;
    this.recorder = null;
    this.paused = true;
    this.frameHandler = null;
    this.errorHandler = null;
    this.pipeline.reset();
    if (recorder) {
      this.invalidateAudioReady(recorder);
      recorder.clearOnError();
      await recorder.stop().catch(() => {});
    }
    await AudioManager.setAudioSessionActivity(false).catch(() => {});
    this.paused = false;
  }
}
