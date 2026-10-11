/// <reference types="node" />
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ExpoConfig } from 'expo/config';

function resolveAppSettings(environment: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tellus-mobile-config-'));
  let config: ExpoConfig;
  try {
    copyFileSync(resolve(__dirname, '../app.config.ts'), join(root, 'app.config.ts'));
    symlinkSync(resolve(__dirname, '../node_modules'), join(root, 'node_modules'), 'dir');
    writeFileSync(join(root, 'app.json'), JSON.stringify({
      expo: { name: 'Configuration test', slug: 'configuration-test', extra: { existing: true } },
    }));
    writeFileSync(join(root, 'package.json'), '{"name":"configuration-test","version":"0.0.0"}');
    writeFileSync(join(root, '.env'), Object.entries(environment)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`).join('\n'));
    // Expo evaluates app.config.ts in Node, outside the client environment variable transform.
    const output = execFileSync(process.execPath, ['-e', `
      const { getConfig } = require(${JSON.stringify(require.resolve('expo/config'))});
      process.stdout.write('CONFIG_RESULT:' + JSON.stringify(getConfig(process.cwd()).exp));
    `], { cwd: root, env: { PATH: process.env.PATH, NODE_ENV: 'development' }, encoding: 'utf8' });
    config = JSON.parse(output.slice(output.lastIndexOf('CONFIG_RESULT:') + 'CONFIG_RESULT:'.length));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  let settings!: typeof import('../src/config/realtimeSpeechConfig').realtimeSpeechConfig;
  jest.doMock('expo-constants', () => ({ __esModule: true, default: { expoConfig: config } }));
  jest.isolateModules(() => {
    settings = require('../src/config/realtimeSpeechConfig').realtimeSpeechConfig;
  });
  expect(config.extra?.existing).toBe(true);
  return settings;
}

it('passes the existing dotenv variable names through Expo config to the app', () => {
  expect(resolveAppSettings({
    API_KEY: ' fixture-access-token ',
    REALTIME_SPEECH_HTTP_URL: ' https://http.fixture.test/// ',
    REALTIME_SPEECH_WS_URL: ' wss://socket.fixture.test/ ',
    APP_ORIGIN: ' https://app.fixture.test/ ',
  })).toEqual({
    audioSdkEnabled: true,
    accessToken: 'fixture-access-token',
    httpBaseUrl: 'https://http.fixture.test',
    websocketBaseUrl: 'wss://socket.fixture.test',
    appOrigin: 'https://app.fixture.test',
  });
});

it('supports EXPO_PUBLIC aliases when the existing variable names are absent', () => {
  expect(resolveAppSettings({
    EXPO_PUBLIC_REALTIME_SPEECH_HTTP_URL: 'https://public-http.fixture.test',
    EXPO_PUBLIC_REALTIME_SPEECH_WS_URL: 'wss://public-socket.fixture.test',
    EXPO_PUBLIC_APP_ORIGIN: 'https://public-app.fixture.test',
  })).toMatchObject({
    httpBaseUrl: 'https://public-http.fixture.test',
    websocketBaseUrl: 'wss://public-socket.fixture.test',
    appOrigin: 'https://public-app.fixture.test',
  });
});

it('prefers the existing variable names when both formats are configured', () => {
  expect(resolveAppSettings({
    REALTIME_SPEECH_HTTP_URL: 'https://http.fixture.test',
    REALTIME_SPEECH_WS_URL: 'wss://socket.fixture.test',
    APP_ORIGIN: 'https://app.fixture.test',
    EXPO_PUBLIC_REALTIME_SPEECH_HTTP_URL: 'https://public-http.fixture.test',
    EXPO_PUBLIC_REALTIME_SPEECH_WS_URL: 'wss://public-socket.fixture.test',
    EXPO_PUBLIC_APP_ORIGIN: 'https://public-app.fixture.test',
  })).toMatchObject({
    httpBaseUrl: 'https://http.fixture.test',
    websocketBaseUrl: 'wss://socket.fixture.test',
    appOrigin: 'https://app.fixture.test',
  });
});

it('keeps the defaults when the settings are missing or blank', () => {
  expect(resolveAppSettings({
    REALTIME_SPEECH_HTTP_URL: ' ',
    REALTIME_SPEECH_WS_URL: '',
    APP_ORIGIN: ' ',
  })).toEqual({
    audioSdkEnabled: true,
    accessToken: '',
    httpBaseUrl: 'https://stgrtsapi.tellus.ai.kr',
    websocketBaseUrl: 'wss://stgrtsapi.tellus.ai.kr',
    appOrigin: 'https://devapp.tellus.ai.kr',
  });
});

it('disables SDK mode only when explicitly configured off', () => {
  expect(resolveAppSettings({ TELLUS_AUDIO_SDK_ENABLED: ' false ' }).audioSdkEnabled).toBe(false);
  expect(resolveAppSettings({ EXPO_PUBLIC_TELLUS_AUDIO_SDK_ENABLED: 'false' }).audioSdkEnabled).toBe(false);
  expect(resolveAppSettings({ TELLUS_AUDIO_SDK_ENABLED: 'true' }).audioSdkEnabled).toBe(true);
});
