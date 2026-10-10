import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllEnvs());

it.each([['', true], ['true', true], ['false', false]] as const)('uses SDK configuration %s independently of capture', async (value, enabled) => {
  vi.resetModules();
  vi.stubEnv('VITE_TELLUS_AUDIO_SDK_ENABLED', value);
  const { realtimeSpeechConfig } = await import('../src/config/realtimeSpeechConfig');
  expect(realtimeSpeechConfig.audioSdkEnabled).toBe(enabled);
});
