import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/**
 * The settings the Electron app reads at runtime. None of them is a secret: the API key stays in
 * the example API server, and the installation token is needed only by `npm run setup`.
 * `npm run build` copies these into `dist/runtime.env`; `npm run dev` passes them to Electron.
 */
export const RUNTIME_KEYS = ['REALTIME_SPEECH_WS_URL', 'TELLUS_EXAMPLE_API_URL', 'TELLUS_AUDIO_SDK_ENABLED'];

// Never passed to the Electron process, wherever they come from.
const WITHHELD_KEYS = [
  'API_KEY',
  'REALTIME_SPEECH_HTTP_URL',
  'TELLUS_AUDIO_ENGINE_TOKEN',
  'TELLUS_AUDIO_DOWNLOAD_BASE_URL',
  // VS Code terminals set this, which would make Electron start as plain Node.js.
  'ELECTRON_RUN_AS_NODE',
  'NODE_OPTIONS',
];

export function readDotenv(url) {
  try {
    return parseEnv(readFileSync(url, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

/** Only the runtime keys that have a value. */
export function pickRuntimeSettings(env) {
  return Object.fromEntries(RUNTIME_KEYS.filter((key) => env[key]).map((key) => [key, env[key]]));
}

/**
 * The environment of the Electron process under `npm run dev`. It gets the runtime keys from
 * `.env` (a value already set in the shell wins) so that the main process never opens `.env`,
 * which also holds the API key.
 */
export function electronEnvironment(processEnv, dotenv, devServerUrl) {
  const env = { ...processEnv, ...pickRuntimeSettings({ ...dotenv, ...processEnv }), TELLUS_DESKTOP_DEV_SERVER_URL: devServerUrl };
  for (const key of WITHHELD_KEYS) delete env[key];
  return env;
}
