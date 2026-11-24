import { writeFileSync } from 'node:fs';
import { pickRuntimeSettings, readDotenv } from './runtime-settings.mjs';

// A packaged app, and `npm start`, read dist/runtime.env. Only the keys the app uses at runtime are
// copied (RUNTIME_KEYS). API_KEY is never among them: the app gets an access token from
// TELLUS_EXAMPLE_API_URL, the server that holds the key. TELLUS_AUDIO_ENGINE_TOKEN is needed only by npm install.
const target = new URL('../dist/runtime.env', import.meta.url);
const settings = pickRuntimeSettings(readDotenv(new URL('../.env', import.meta.url)));
const lines = Object.entries(settings).map(([key, value]) => `${key}=${value}`);
writeFileSync(target, lines.length > 0 ? `${lines.join('\n')}\n` : '');

console.log(`Wrote ${lines.length} runtime setting(s) to dist/runtime.env: ${Object.keys(settings).join(', ') || 'none'}`);
