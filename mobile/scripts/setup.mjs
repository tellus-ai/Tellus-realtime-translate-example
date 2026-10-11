import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = new URL('../', import.meta.url);
const envFile = new URL('.env', root);
const env = { ...(existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {}), ...process.env };
const baseUrl = env.TELLUS_AUDIO_DOWNLOAD_BASE_URL?.trim()
  || env.REALTIME_SPEECH_HTTP_URL?.trim()
  || env.EXPO_PUBLIC_REALTIME_SPEECH_HTTP_URL?.trim()
  || 'https://stgrtsapi.tellus.ai.kr';
const installationToken = env.TELLUS_AUDIO_ENGINE_TOKEN;

try {
  if (!installationToken) throw new Error('Set TELLUS_AUDIO_ENGINE_TOKEN to your Tellus-issued installation token in mobile/.env. API_KEY is only for runtime login.');
  if (!process.env.npm_execpath) throw new Error('Run this script with npm run setup.');
  console.log('Installing the mobile SDK and native engine assets...');
  // Explicit installation and verification also work when npm lifecycle scripts are disabled.
  for (const args of [
    [process.env.npm_execpath, 'ci', '--legacy-peer-deps'],
    [fileURLToPath(new URL('node_modules/@tellus-ai/audio-sdk-mobile/dist/installer/install-binary-cli.js', root))],
    [fileURLToPath(new URL('node_modules/@tellus-ai/audio-sdk-mobile/dist/installer/check-binary-cli.js', root))],
  ]) {
    const result = spawnSync(process.execPath, args, {
      cwd: fileURLToPath(root), stdio: 'inherit',
      env: { ...env, TELLUS_AUDIO_ENGINE_TOKEN: installationToken, TELLUS_AUDIO_DOWNLOAD_BASE_URL: baseUrl },
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
    if (process.exitCode !== 0) break;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'SDK setup failed.');
  process.exitCode = 1;
}
