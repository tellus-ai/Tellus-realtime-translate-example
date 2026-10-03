import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { downloadSdk } from './audio-download.mjs';

const root = new URL('../', import.meta.url);
const envFile = new URL('.env', root);
const env = { ...(existsSync(envFile) ? parseEnv(readFileSync(envFile, 'utf8')) : {}), ...process.env };
const baseUrl = env.TELLUS_AUDIO_DOWNLOAD_BASE_URL || env.REALTIME_SPEECH_HTTP_URL || 'https://stgrtsapi.tellus.ai.kr';
const loginToken = env.TELLUS_AUDIO_ENGINE_TOKEN || env.API_KEY;
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const dependency = manifest.dependencies['@tellus-ai/audio-sdk'];
const version = dependency.match(/^file:vendor\/tellus-ai-audio-sdk-(\d+\.\d+\.\d+)\.tgz$/)?.[1];

try {
  if (!version) throw new Error('The SDK dependency must pin a versioned vendor tarball.');
  console.log(`Downloading SDK ${version} through the artifact token API and CloudFront...`);
  const { filename, archive, checksum } = await downloadSdk({ baseUrl, version, loginToken });
  const vendor = new URL('vendor/', root);
  mkdirSync(vendor, { recursive: true });
  const target = new URL(filename, vendor);
  const temporary = new URL(`${filename}.tmp`, vendor);
  writeFileSync(temporary, archive, { mode: 0o600 });
  renameSync(temporary, target);
  writeFileSync(new URL(`${filename}.sha256`, vendor), checksum, { mode: 0o600 });
  console.log(`Verified ${filename}. Installing dependencies and the native engine...`);
  if (!process.env.npm_execpath) throw new Error('Run this script with npm run setup.');
  const result = spawnSync(process.execPath, [process.env.npm_execpath, 'ci'], {
    cwd: fileURLToPath(root), stdio: 'inherit',
    env: { ...env, TELLUS_AUDIO_ENGINE_TOKEN: loginToken, TELLUS_AUDIO_DOWNLOAD_BASE_URL: baseUrl },
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
  // Verify the engine even when the user's npm configuration disables lifecycle scripts.
  if (process.exitCode === 0) {
    const engine = spawnSync(process.execPath, [fileURLToPath(new URL('node_modules/@tellus-ai/audio-sdk/dist/installer/install-binary-cli.js', root))], {
      cwd: fileURLToPath(root), stdio: 'inherit',
      env: { ...env, TELLUS_AUDIO_ENGINE_TOKEN: loginToken, TELLUS_AUDIO_DOWNLOAD_BASE_URL: baseUrl },
    });
    if (engine.error) throw engine.error;
    process.exitCode = engine.status ?? 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'SDK setup failed.');
  process.exitCode = 1;
}
