import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error The script is plain JavaScript without type declarations.
import { electronEnvironment, pickRuntimeSettings, RUNTIME_KEYS } from '../scripts/runtime-settings.mjs';

const DOTENV = {
  API_KEY: 'tl_test_secret-key',
  TELLUS_AUDIO_ENGINE_TOKEN: 'installation-secret',
  TELLUS_AUDIO_DOWNLOAD_BASE_URL: 'https://public.speech.tellus.ai.kr',
  REALTIME_SPEECH_HTTP_URL: 'https://public.speech.tellus.ai.kr',
  REALTIME_SPEECH_WS_URL: 'wss://from-dotenv.example.test',
  TELLUS_AUDIO_SDK_ENABLED: 'true',
};

describe('runtime settings', () => {
  it('are the three keys the app reads, none of them a secret', () => {
    expect(RUNTIME_KEYS).toEqual(['REALTIME_SPEECH_WS_URL', 'TELLUS_EXAMPLE_API_URL', 'TELLUS_AUDIO_SDK_ENABLED']);
    expect(pickRuntimeSettings(DOTENV)).toEqual({
      REALTIME_SPEECH_WS_URL: 'wss://from-dotenv.example.test',
      TELLUS_AUDIO_SDK_ENABLED: 'true',
    });
  });
});

describe('electronEnvironment', () => {
  const devServerUrl = 'http://127.0.0.1:5173/';

  it('passes the runtime keys of .env to Electron, so that the main process does not open .env', () => {
    const env = electronEnvironment({ PATH: '/usr/bin', HOME: '/Users/me' }, DOTENV, devServerUrl);
    expect(env).toEqual({
      PATH: '/usr/bin',
      HOME: '/Users/me',
      REALTIME_SPEECH_WS_URL: 'wss://from-dotenv.example.test',
      TELLUS_AUDIO_SDK_ENABLED: 'true',
      TELLUS_DESKTOP_DEV_SERVER_URL: devServerUrl,
    });
  });

  it('never passes the API key or the installation credentials, also when the shell sets them', () => {
    const shell = {
      PATH: '/usr/bin',
      API_KEY: 'tl_test_from-shell',
      TELLUS_AUDIO_ENGINE_TOKEN: 'shell-installation-secret',
      ELECTRON_RUN_AS_NODE: '1',
      NODE_OPTIONS: '--inspect',
    };
    const env = electronEnvironment(shell, DOTENV, devServerUrl);
    expect(JSON.stringify(env)).not.toMatch(/secret|tl_test_/);
    for (const key of ['API_KEY', 'TELLUS_AUDIO_ENGINE_TOKEN', 'TELLUS_AUDIO_DOWNLOAD_BASE_URL',
      'REALTIME_SPEECH_HTTP_URL', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS']) {
      expect(env).not.toHaveProperty(key);
    }
  });

  it('is the only way the main process gets them: it reads dist/runtime.env, never .env', () => {
    const main = readFileSync(new URL('../electron/main.ts', import.meta.url), 'utf8');
    // A path to `.env` in code; comments name it in backticks.
    expect(main).not.toMatch(/['"]\.env['"]|getAppPath\(\)/);
    expect(main).toContain("join(__dirname, '../runtime.env')");
  });

  it('lets a value set in the shell win over .env', () => {
    const env = electronEnvironment({ REALTIME_SPEECH_WS_URL: 'wss://from-shell.example.test' }, DOTENV, devServerUrl);
    expect(env.REALTIME_SPEECH_WS_URL).toBe('wss://from-shell.example.test');
  });
});
