import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BrowserMicrophone } from '../src/audio/BrowserMicrophone';

const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  capture: { stop: vi.fn() },
  engine: { createCapture: vi.fn(), dispose: vi.fn() },
}));
vi.mock('@tellus-ai/audio-sdk-web', () => ({ AudioEngine: { init: sdk.init } }));

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('document', { baseURI: 'https://example.test/' });
  sdk.init.mockResolvedValue(sdk.engine);
  sdk.engine.createCapture.mockReturnValue(sdk.capture);
});
afterEach(() => vi.unstubAllGlobals());

describe('required browser Audio SDK', () => {
  it('uses SDK capture with VAD disabled and no Silero model even when requested', async () => {
    const microphone = new BrowserMicrophone();
    expect(microphone.audioSdkReady).toBe(false);
    await microphone.prepare(true);
    expect(sdk.init).toHaveBeenCalledWith(
      expect.objectContaining({ vadEnabled: false }),
      expect.objectContaining({ encryptedModels: ['https://example.test/tellus-audio/models/fe-s16.temc'] }),
    );
    expect(microphone.audioSdkReady).toBe(true);
    await microphone.stop();
    expect(microphone.audioSdkReady).toBe(false);
    expect(sdk.engine.dispose).toHaveBeenCalledOnce();
  });

  it('reports initialization failure without enabling SDK capture', async () => {
    sdk.init.mockRejectedValueOnce(new Error('missing WASM engine'));
    const microphone = new BrowserMicrophone();
    await expect(microphone.prepare(false)).rejects.toThrow('Audio SDK is required but could not be initialized: missing WASM engine');
    expect(microphone.audioSdkReady).toBe(false);
    expect(sdk.engine.createCapture).not.toHaveBeenCalled();
  });

  it('disposes initialization that completes after stop without enabling capture', async () => {
    let resolve!: (engine: typeof sdk.engine) => void;
    sdk.init.mockReturnValueOnce(new Promise<typeof sdk.engine>((done) => { resolve = done; }));
    const microphone = new BrowserMicrophone();
    const preparing = microphone.prepare(false);
    await vi.waitFor(() => expect(sdk.init).toHaveBeenCalledOnce());
    await microphone.stop();
    resolve(sdk.engine);
    await preparing;
    expect(microphone.audioSdkReady).toBe(false);
    expect(sdk.engine.createCapture).not.toHaveBeenCalled();
    expect(sdk.engine.dispose).toHaveBeenCalledOnce();
  });
});
