import { beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({
  init: vi.fn(),
  engine: { getStatus: vi.fn(), createCapture: vi.fn() },
}));
vi.mock('@tellus-ai/audio-sdk-desktop', () => ({ AudioEngine: { init: sdk.init } }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  sdk.init.mockResolvedValue(sdk.engine);
  sdk.engine.getStatus.mockReturnValue({ initialized: true });
  sdk.engine.createCapture.mockReturnValue({});
});

describe('required desktop Audio SDK', () => {
  it('initializes without VAD and marks only SDK capture as enabled', async () => {
    const { createMicrophoneCapture } = await import('../electron/audio/audioEngine');
    const capture = await createMicrophoneCapture(async () => true);
    expect(sdk.init).toHaveBeenCalledWith(expect.objectContaining({ vadEnabled: false }));
    expect(capture.audioSdkReady).toBe(true);
  });

  it('reports SDK initialization failure and allows a later retry', async () => {
    const { createMicrophoneCapture } = await import('../electron/audio/audioEngine');
    sdk.init.mockRejectedValueOnce(new Error('missing native binary'));
    await expect(createMicrophoneCapture(async () => true)).rejects.toThrow('Audio SDK is required but could not be initialized: missing native binary');
    await expect(createMicrophoneCapture(async () => true)).resolves.toMatchObject({ audioSdkReady: true });
  });

  it('rejects an uninitialized SDK before creating capture', async () => {
    const { createMicrophoneCapture } = await import('../electron/audio/audioEngine');
    sdk.engine.getStatus.mockReturnValue({ initialized: false });
    await expect(createMicrophoneCapture(async () => true)).rejects.toThrow('Audio SDK is required but is not initialized.');
    expect(sdk.engine.createCapture).not.toHaveBeenCalled();
  });
});
