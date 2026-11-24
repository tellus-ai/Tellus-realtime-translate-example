import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

// Runs the real script in a copy of the project layout, so that it reads that `.env`.
let root: string | null = null;

afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = null;
});

function writeRuntimeEnv(dotenv: string): string {
  root = mkdtempSync(join(tmpdir(), 'tellus-runtime-env-'));
  mkdirSync(join(root, 'scripts'));
  mkdirSync(join(root, 'dist'));
  for (const script of ['write-runtime-env.mjs', 'runtime-settings.mjs']) {
    copyFileSync(join(__dirname, '../scripts', script), join(root, 'scripts', script));
  }
  writeFileSync(join(root, '.env'), dotenv);
  execFileSync(process.execPath, [join(root, 'scripts/write-runtime-env.mjs')], { stdio: 'pipe' });
  const target = join(root, 'dist/runtime.env');
  return existsSync(target) ? readFileSync(target, 'utf8') : '';
}

describe('write-runtime-env', () => {
  it('never copies the API key, the installation token, or the Tellus HTTP URL into the packaged app', () => {
    const runtime = writeRuntimeEnv([
      'API_KEY=tl_test_secret-key',
      'TELLUS_AUDIO_ENGINE_TOKEN=installation-secret',
      'REALTIME_SPEECH_HTTP_URL=https://public.speech.tellus.ai.kr',
      'REALTIME_SPEECH_WS_URL=wss://public.speech.tellus.ai.kr',
      'TELLUS_EXAMPLE_API_URL=https://backend.example.test/__tellus/api',
      'TELLUS_AUDIO_SDK_ENABLED=true',
    ].join('\n'));

    expect(runtime).toBe([
      'REALTIME_SPEECH_WS_URL=wss://public.speech.tellus.ai.kr',
      'TELLUS_EXAMPLE_API_URL=https://backend.example.test/__tellus/api',
      'TELLUS_AUDIO_SDK_ENABLED=true',
      '',
    ].join('\n'));
    expect(runtime).not.toContain('secret');
  });

  it('writes an empty file when nothing the app reads at runtime is set', () => {
    expect(writeRuntimeEnv('API_KEY=tl_test_secret-key\n')).toBe('');
  });
});
