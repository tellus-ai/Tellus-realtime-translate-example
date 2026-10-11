import { AudioEngine } from '@tellus-ai/audio-sdk-mobile';
import { NativeMicrophone } from '../src/audio/NativeMicrophone';

jest.mock('@tellus-ai/audio-sdk-mobile', () => ({ AudioEngine: { init: jest.fn() } }));
jest.mock('@tellus-ai/audio-sdk-mobile/authorization', () => ({ attachEngineAuthorization: jest.fn() }));

const capture = { getStatus: jest.fn(), setDenoiseEnabled: jest.fn(), stop: jest.fn(), dispose: jest.fn() };
const createCapture = jest.fn(() => capture);
const engine = { createCapture } as unknown as AudioEngine;
const init = jest.mocked(AudioEngine.init);

beforeEach(() => {
  jest.clearAllMocks();
  init.mockResolvedValue(engine);
  capture.getStatus.mockResolvedValue({ state: 'stopped', denoiseEnabled: true });
});

describe('mobile SDK denoise', () => {
  it('applies a pre-start selection instead of the environment default', async () => {
    const microphone = new NativeMicrophone();
    await microphone.setDenoiseEnabled(false);
    capture.getStatus.mockResolvedValue({ state: 'stopped', denoiseEnabled: false });
    await microphone.prepare(false);
    expect(init).toHaveBeenCalledWith(expect.objectContaining({ denoiseEnabled: false }));
    expect(microphone.denoiseEnabled).toBe(false);
  });

  it('changes the existing SDK capture and reads its applied state without restarting it', async () => {
    const microphone = new NativeMicrophone();
    await microphone.prepare(false);
    capture.getStatus.mockResolvedValue({ state: 'running', denoiseEnabled: false });
    await expect(microphone.setDenoiseEnabled(false)).resolves.toBe(false);
    expect(capture.setDenoiseEnabled).toHaveBeenCalledWith(false);
    expect(microphone.denoiseEnabled).toBe(false);
    expect(init).toHaveBeenCalledTimes(1);
    expect(capture.dispose).not.toHaveBeenCalled();
  });

  it('keeps the last setting when the SDK rejects the change', async () => {
    const microphone = new NativeMicrophone();
    await microphone.prepare(false);
    capture.setDenoiseEnabled.mockRejectedValueOnce(new Error('model_not_ready'));
    await expect(microphone.setDenoiseEnabled(false)).rejects.toThrow('model_not_ready');
    expect(microphone.denoiseEnabled).toBe(true);
  });
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
