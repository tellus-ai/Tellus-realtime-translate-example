import { AudioEngine } from '@tellus-ai/audio-sdk-mobile';
import { attachEngineAuthorization } from '@tellus-ai/audio-sdk-mobile/authorization';
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
  it('starts with denoise off, in close_talk mode with the engine default settings written out', async () => {
    const microphone = new NativeMicrophone();
    expect(microphone.denoiseEnabled).toBe(false);
    capture.getStatus.mockResolvedValue({ state: 'stopped', denoiseEnabled: false });
    await microphone.prepare(false);
    expect(init).toHaveBeenCalledWith(expect.objectContaining({
      denoiseEnabled: false,
      denoiseMode: 'close_talk', closeTalkThresholdDb: 30, denoiseAttenuationLimitDb: 12,
      closeTalkHoldMs: 250, closeTalkKeepGapDb: 4, closeTalkLevelMarginDb: 2, closeTalkLevelMinDbfs: -20,
    }));
    expect(microphone.denoiseEnabled).toBe(false);
  });

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

describe('mobile engine approval', () => {
  it('asks for the current access token for the first approval and for every renewal', async () => {
    const attach = jest.mocked(attachEngineAuthorization);
    attach.mockReturnValue({ ready: Promise.resolve(), dispose: jest.fn() } as unknown as ReturnType<typeof attachEngineAuthorization>);
    const microphone = new NativeMicrophone();
    await microphone.prepare(false);
    const socket = {} as WebSocket;
    const tokens = ['tl_at_1', 'tl_at_2'];
    await microphone.authorize(socket, 'conversation-1', async () => tokens.shift()!, jest.fn());

    const [attachedSocket, attachedCapture, options] = attach.mock.calls[0]!;
    expect(attachedSocket).toBe(socket);
    expect(attachedCapture).toBe(capture);
    expect(options.conversationId).toBe('conversation-1');
    // A renewal can come after the first token expired, so each request gets the current one.
    await expect(options.getAccessToken()).resolves.toBe('tl_at_1');
    await expect(options.getAccessToken()).resolves.toBe('tl_at_2');
  });
});

describe('required mobile Audio SDK', () => {
  it('uses SDK capture with VAD disabled even when requested and clears usage on stop', async () => {
    const microphone = new NativeMicrophone();
    expect(microphone.audioSdkReady).toBe(false);
    await microphone.prepare(true);
    expect(init).toHaveBeenCalledWith(expect.objectContaining({ vadEnabled: false, denoiseMode: 'close_talk' }));
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
