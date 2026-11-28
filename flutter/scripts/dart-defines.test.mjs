import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { dartDefines, writeDartDefines } from './dart-defines.mjs';

test('writes the app settings without the API key and the installation token', t => {
  const directory = mkdtempSync(join(tmpdir(), 'tellus-flutter-defines-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, '.dart-defines.json');
  writeDartDefines({
    API_KEY: 'tl_test_marker-api-key',
    TELLUS_AUDIO_ENGINE_TOKEN: 'marker-installation-token',
    TELLUS_AUDIO_DOWNLOAD_BASE_URL: 'https://marker-download.invalid',
    REALTIME_SPEECH_HTTP_URL: 'https://marker-http.invalid',
    TELLUS_EXAMPLE_API_CLIENTS: '192.168.0.12',
    TELLUS_EXAMPLE_SERVER_PORT: '9090',
    TELLUS_EXAMPLE_SERVER_URL: ' http://192.168.0.10:9090 ',
    TELLUS_EXAMPLE_API_URL: 'https://backend.invalid/tellus',
    REALTIME_SPEECH_WS_URL: 'wss://socket.invalid',
    APP_ORIGIN: 'https://app.invalid',
    TELLUS_DENOISE: 'true',
  }, file);

  const written = readFileSync(file, 'utf8');
  assert.doesNotMatch(written, /marker/);
  assert.deepEqual(JSON.parse(written), {
    TELLUS_API_KEY_CONFIGURED: 'true',
    TELLUS_EXAMPLE_SERVER_URL: 'http://192.168.0.10:9090',
    TELLUS_EXAMPLE_API_URL: 'https://backend.invalid/tellus',
    REALTIME_SPEECH_WS_URL: 'wss://socket.invalid',
    APP_ORIGIN: 'https://app.invalid',
    TELLUS_DENOISE: 'true',
  });
});

test('tells the app only whether an API key is configured', () => {
  assert.equal(dartDefines({ API_KEY: 'tl_test_marker-api-key' }).TELLUS_API_KEY_CONFIGURED, 'true');
  for (const env of [{}, { API_KEY: '' }, { API_KEY: '  ' }]) {
    assert.equal(dartDefines(env).TELLUS_API_KEY_CONFIGURED, 'false');
  }
});

test('points the app at this computer on the development server port unless an address is set', () => {
  assert.deepEqual(dartDefines({}), {
    TELLUS_API_KEY_CONFIGURED: 'false',
    TELLUS_EXAMPLE_SERVER_URL: 'http://localhost:8787',
    TELLUS_EXAMPLE_API_URL: '',
    REALTIME_SPEECH_WS_URL: '',
    APP_ORIGIN: '',
    TELLUS_DENOISE: 'false',
  });
  assert.equal(dartDefines({ TELLUS_EXAMPLE_SERVER_PORT: '9090' }).TELLUS_EXAMPLE_SERVER_URL, 'http://localhost:9090');
});

test('writes exactly the settings that the app reads', () => {
  const source = readFileSync(new URL('../lib/src/config/realtime_speech_config.dart', import.meta.url), 'utf8');
  const read = [...source.matchAll(/fromEnvironment\(\s*['"]([A-Z0-9_]+)['"]/g)].map(match => match[1]);
  assert.deepEqual(Object.keys(dartDefines({})).sort(), read.sort());
});

test('refuses to write the API key or the installation token placed in another setting', () => {
  for (const [secret, value] of [['API_KEY', 'tl_test_marker-api-key'], ['TELLUS_AUDIO_ENGINE_TOKEN', 'marker-installation-token']]) {
    for (const name of ['TELLUS_EXAMPLE_SERVER_URL', 'TELLUS_EXAMPLE_API_URL', 'REALTIME_SPEECH_WS_URL', 'APP_ORIGIN']) {
      const env = { [secret]: value, [name]: `https://x.invalid/?key="${value}"\n` };
      assert.throws(() => dartDefines(env), error => error.message.includes(name) && !error.message.includes(value), `${secret} in ${name}`);
    }
  }
});

test('writes values with quotes, backslashes and newlines as valid JSON', t => {
  const directory = mkdtempSync(join(tmpdir(), 'tellus-flutter-defines-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const file = join(directory, '.dart-defines.json');
  const origin = 'https://app.invalid/"},"API_KEY":"x\\\n\u2028';
  writeDartDefines({ APP_ORIGIN: origin }, file);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).APP_ORIGIN, origin.trim());
});

