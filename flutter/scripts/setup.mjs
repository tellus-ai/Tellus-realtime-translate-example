import { prepareSdk } from './prepare-sdk.mjs';
import { readEnv } from './env.mjs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const env = readEnv();
const baseUrl = env.TELLUS_AUDIO_DOWNLOAD_BASE_URL?.trim()
  || env.REALTIME_SPEECH_HTTP_URL?.trim()
  || 'https://public.speech.tellus.ai.kr';
const installationToken = env.TELLUS_AUDIO_ENGINE_TOKEN;

try {
  if (!installationToken) throw new Error('Set TELLUS_AUDIO_ENGINE_TOKEN to your Tellus-issued installation token in flutter/.env. API_KEY is the runtime API key from the Tellus API Console.');
  if (!process.env.npm_execpath) throw new Error('Run this script with npm run setup.');
  const setupEnv = { ...env, TELLUS_AUDIO_ENGINE_TOKEN: installationToken, TELLUS_AUDIO_DOWNLOAD_BASE_URL: baseUrl };
  prepareSdk(root, setupEnv, process.env.npm_execpath);
  console.log('Installing the native engine assets and linking the Flutter plugin...');
  // The plugin is a path dependency (pubspec.yaml), so the engine is installed inside the checkout.
  const installer = new URL('.sdk/platforms/flutter/dist/installer/', root);
  for (const [command, ...args] of [
    [process.execPath, fileURLToPath(new URL('install-binary-cli.js', installer))],
    [process.execPath, fileURLToPath(new URL('check-binary-cli.js', installer))],
    ['flutter', 'pub', 'get'],
  ]) {
    const result = spawnSync(command, args, { cwd: fileURLToPath(root), stdio: 'inherit', env: setupEnv });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
    if (process.exitCode !== 0) break;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'SDK setup failed.');
  process.exitCode = Number.isInteger(error.status) && error.status > 0 ? error.status : 1;
}
