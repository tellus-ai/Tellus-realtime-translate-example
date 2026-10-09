import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = new URL('../', import.meta.url);
const envFile = new URL('.env', root);
const env = { ...(existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {}), ...process.env };
const baseUrl = env.TELLUS_AUDIO_DOWNLOAD_BASE_URL || env.REALTIME_SPEECH_HTTP_URL || 'https://stgrtsapi.tellus.ai.kr';
const installationToken = env.TELLUS_AUDIO_ENGINE_TOKEN;

try {
  if (!installationToken) throw new Error('Set TELLUS_AUDIO_ENGINE_TOKEN to your Tellus-issued installation token in desktop/.env. API_KEY is only for runtime login.');
  console.log('Installing SDK from GitHub and the native engine through CloudFront...');
  if (!process.env.npm_execpath) throw new Error('Run this script with npm run setup.');
  const result = spawnSync(process.execPath, [process.env.npm_execpath, 'ci'], {
    cwd: fileURLToPath(root), stdio: 'inherit',
    env: { ...env, TELLUS_AUDIO_ENGINE_TOKEN: installationToken, TELLUS_AUDIO_DOWNLOAD_BASE_URL: baseUrl },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  // Verify the engine even when the user's npm configuration disables lifecycle scripts.
  if (process.exitCode === 0) {
    const engine = spawnSync(process.execPath, [fileURLToPath(new URL('node_modules/@tellus-ai/audio-sdk-desktop/dist/installer/install-binary-cli.js', root))], {
      cwd: fileURLToPath(root), stdio: 'inherit',
      env: { ...env, TELLUS_AUDIO_ENGINE_TOKEN: installationToken, TELLUS_AUDIO_DOWNLOAD_BASE_URL: baseUrl },
    });
    if (engine.error) throw engine.error;
    process.exitCode = engine.status ?? 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'SDK setup failed.');
  process.exitCode = 1;
}
