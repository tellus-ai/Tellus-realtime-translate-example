const mockRecorderInstances: Array<{
  audioCallbacks: Array<(event: any) => void>;
  errorCallbacks: Array<(event: { message: string }) => void>;
  events: string[];
  startResult: { status: 'success' } | { status: 'error'; message: string };
}> = [];

jest.mock('react-native-permissions', () => ({
  PERMISSIONS: { IOS: { MICROPHONE: 'ios.microphone' }, ANDROID: { RECORD_AUDIO: 'android.microphone' } },
  RESULTS: { GRANTED: 'granted', LIMITED: 'limited' },
  request: jest.fn(async () => 'granted'),
}));

jest.mock('react-native-audio-api', () => {
  class MockAudioRecorder {
    audioCallbacks: Array<(event: any) => void> = [];
    errorCallbacks: Array<(event: { message: string }) => void> = [];
    events: string[] = [];
    startResult: { status: 'success' } | { status: 'error'; message: string } = { status: 'success' };

    constructor() {
      mockRecorderInstances.push(this);
    }

    onAudioReady(_options: unknown, callback: (event: any) => void) {
      this.events.push('register-audio');
      this.audioCallbacks.push(callback);
      return { status: 'success' };
    }
    clearOnAudioReady() { this.events.push('clear-audio'); }
    onError(callback: (event: { message: string }) => void) {
      this.events.push('register-error');
      this.errorCallbacks.push(callback);
    }
    clearOnError() { this.events.push('clear-error'); }
    async start() { return this.startResult; }
    pause() { this.events.push('pause'); }
    resume() { this.events.push('resume'); }
    async stop() { this.events.push('stop'); return { status: 'success' }; }
  }

  return {
    AudioManager: {
      setAudioSessionOptions: jest.fn(),
      setAudioSessionActivity: jest.fn(async () => {}),
    },
    AudioRecorder: MockAudioRecorder,
  };
});

import { NativeMicrophone } from '../src/audio/NativeMicrophone';

function audioEvent(sampleCount: number) {
  return {
    buffer: {
      sampleRate: 16_000,
      getChannelData: () => new Float32Array(sampleCount),
    },
  };
}

describe('NativeMicrophone capture boundaries', () => {
  beforeEach(() => {
    mockRecorderInstances.length = 0;
  });

  it('invalidates paused callbacks and starts the resumed pipeline from a clean frame', async () => {
    const microphone = new NativeMicrophone();
    const frames: unknown[] = [];
    await microphone.start((frame) => frames.push(frame), () => {});
    const recorder = mockRecorderInstances[0]!;
    const staleCallback = recorder.audioCallbacks[0]!;

    staleCallback(audioEvent(160));
    await microphone.pause();
    staleCallback(audioEvent(320));
    await microphone.resume();
    const resumedCallback = recorder.audioCallbacks[1]!;

    staleCallback(audioEvent(320));
    resumedCallback(audioEvent(160));
    expect(frames).toHaveLength(0);
    resumedCallback(audioEvent(160));
    expect(frames).toHaveLength(1);
    expect(recorder.events.indexOf('register-audio', 1)).toBeLessThan(recorder.events.indexOf('resume'));
  });

  it('forwards a recorder error once and ignores it after stop', async () => {
    const microphone = new NativeMicrophone();
    const errors: string[] = [];
    await microphone.start(() => {}, (error) => errors.push(error.message));
    const recorder = mockRecorderInstances[0]!;
    const errorCallback = recorder.errorCallbacks[0]!;

    errorCallback({ message: 'capture failed' });
    errorCallback({ message: 'duplicate' });
    await microphone.stop();
    errorCallback({ message: 'stale' });

    expect(errors).toEqual(['capture failed']);
    expect(recorder.events).toEqual(expect.arrayContaining(['clear-audio', 'clear-error', 'stop']));
  });
});
