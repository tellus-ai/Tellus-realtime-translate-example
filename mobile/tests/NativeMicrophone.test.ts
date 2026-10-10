import { AudioEngine } from '@tellus-ai/audio-sdk-mobile';
import { NativeMicrophone } from '../src/audio/NativeMicrophone';

jest.mock('@tellus-ai/audio-sdk-mobile', () => ({ AudioEngine: { init: jest.fn() } }));
jest.mock('@tellus-ai/audio-sdk-mobile/authorization', () => ({ attachEngineAuthorization: jest.fn() }));

const capture = { getStatus: jest.fn(), stop: jest.fn(), dispose: jest.fn() };
const createCapture = jest.fn(() => capture);
const engine = { createCapture } as unknown as AudioEngine;
const init = jest.mocked(AudioEngine.init);

beforeEach(() => {
  jest.clearAllMocks();
  init.mockResolvedValue(engine);
  capture.getStatus.mockResolvedValue({ state: 'stopped' });
});

describe('required mobile Audio SDK', () => {
  it('uses SDK capture with VAD disabled even when requested and clears usage on stop', async () => {
    const microphone = new NativeMicrophone();
    expect(microphone.audioSdkReady).toBe(false);
    await microphone.prepare(true);
    expect(init).toHaveBeenCalledWith(expect.objectContaining({ vadEnabled: false }));
    expect(microphone.audioSdkReady).toBe(true);
    await microphone.stop();
    expect(microphone.audioSdkReady).toBe(false);
    expect(capture.dispose).toHaveBeenCalledTimes(1);
  });

  it('reports initialization failure without enabling SDK capture', async () => {
    init.mockRejectedValueOnce(new Error('missing native module'));
    const microphone = new NativeMicrophone();
    await expect(microphone.prepare(false)).rejects.toThrow('Audio SDK is required but could not be initialized: missing native module');
    expect(microphone.audioSdkReady).toBe(false);
    expect(createCapture).not.toHaveBeenCalled();
  });
});
