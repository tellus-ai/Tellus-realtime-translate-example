// Writes .dart-defines.json, the settings that `flutter run --dart-define-from-file` builds into the
// app (lib/src/config/realtime_speech_config.dart reads them). Anything in that file can be read out
// of the app, so the API key and the engine installation token are never written: the app only
// learns whether the development server has a key.
//
//   node scripts/dart-defines.mjs      (`npm start` does this before `flutter run`)
import { writeFileSync } from 'node:fs';
import { readEnv, serverPort } from './env.mjs';

export function dartDefines(env) {
  const value = name => env[name]?.trim() ?? '';
  const defines = {
    TELLUS_API_KEY_CONFIGURED: String(value('API_KEY') !== ''),
    TELLUS_EXAMPLE_SERVER_URL: value('TELLUS_EXAMPLE_SERVER_URL') || `http://localhost:${serverPort(env)}`,
    // An empty value leaves the default to the app.
    TELLUS_EXAMPLE_API_URL: value('TELLUS_EXAMPLE_API_URL'),
    REALTIME_SPEECH_WS_URL: value('REALTIME_SPEECH_WS_URL'),
    APP_ORIGIN: value('APP_ORIGIN'),
    TELLUS_DENOISE: String(value('TELLUS_DENOISE') === 'true'),
  };
  // A secret pasted into a setting that is copied into the app would be built into it as well.
  const copied = ['TELLUS_EXAMPLE_SERVER_URL', 'TELLUS_EXAMPLE_API_URL', 'REALTIME_SPEECH_WS_URL', 'APP_ORIGIN'];
  for (const secret of ['API_KEY', 'TELLUS_AUDIO_ENGINE_TOKEN']) {
    const found = value(secret) && copied.find(name => value(name).includes(value(secret)));
    if (found) throw new Error(`${found} contains the value of ${secret}. Remove it from that setting in flutter/.env.`);
  }
  return defines;
}

export function writeDartDefines(env = readEnv(), file = new URL('../.dart-defines.json', import.meta.url)) {
  writeFileSync(file, `${JSON.stringify(dartDefines(env), null, 2)}\n`);
}

if (import.meta.main) writeDartDefines();
