import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

// A packaged app reads dist/runtime.env instead of .env. Only the keys the app uses at runtime are
// copied: TELLUS_AUDIO_ENGINE_TOKEN is needed only by npm install and must never ship in the app.
const RUNTIME_KEYS = ['REALTIME_SPEECH_HTTP_URL', 'REALTIME_SPEECH_WS_URL', 'API_KEY'];
const source = new URL('../.env', import.meta.url);
const target = new URL('../dist/runtime.env', import.meta.url);

const env = existsSync(source) ? parseEnv(readFileSync(source, 'utf8')) : {};
const lines = RUNTIME_KEYS.filter((key) => env[key]).map((key) => `${key}=${env[key]}`);
writeFileSync(target, lines.length > 0 ? `${lines.join('\n')}\n` : '');

console.log(`Wrote ${lines.length} runtime setting(s) to dist/runtime.env: ${lines.map((line) => line.split('=')[0]).join(', ') || 'none'}`);
