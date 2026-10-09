import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

function runSetup(dotenv, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tellus-web-setup-'));
  try {
    mkdirSync(join(root, 'scripts'));
    writeFileSync(join(root, 'scripts/setup.mjs'), readFileSync(new URL('../scripts/setup.mjs', import.meta.url)));
    writeFileSync(join(root, '.env'), dotenv);
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    const installerDir = join(root, 'node_modules/@tellus-ai/audio-sdk-web/dist/installer');
    mkdirSync(installerDir, { recursive: true });
    const recorder = `import { appendFileSync } from 'node:fs';
const step = process.argv.slice(2).join(' ') || 'engine';
appendFileSync(process.env.SETUP_CALLS, JSON.stringify({ step,
  token: process.env.TELLUS_AUDIO_ENGINE_TOKEN,
  baseUrl: process.env.TELLUS_AUDIO_DOWNLOAD_BASE_URL }) + '\\n');
process.exitCode = Number(process.env[step === 'ci' ? 'SETUP_CI_EXIT' : 'SETUP_ENGINE_EXIT'] || 0);
`;
    writeFileSync(join(root, 'npm.mjs'), recorder);
    writeFileSync(join(installerDir, 'install-binary-cli.js'), recorder);
    const callsFile = join(root, 'calls.jsonl');
    const result = spawnSync(process.execPath, [join(root, 'scripts/setup.mjs')], {
      cwd: root,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, npm_execpath: join(root, 'npm.mjs'), SETUP_CALLS: callsFile, ...overrides },
    });
    const calls = existsSync(callsFile)
      ? readFileSync(callsFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
      : [];
    return { ...result, calls };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

it('rejects a runtime API token before installing dependencies when the installation token is missing', () => {
  const result = runSetup('API_KEY=runtime-only\n');
  expect(result.status).toBe(1);
  expect(result.stderr).toContain('TELLUS_AUDIO_ENGINE_TOKEN');
  expect(result.calls).toEqual([]);
});

it('passes the dotenv installation token through dependency, engine, and asset setup despite disabled lifecycle scripts', () => {
  const result = runSetup('TELLUS_AUDIO_ENGINE_TOKEN=fixture-installation-token\nVITE_REALTIME_SPEECH_HTTP_URL=https://fixture.tellus.invalid\n', {
    npm_config_ignore_scripts: 'true',
  });
  expect(result.status).toBe(0);
  expect(result.calls).toEqual(['ci', 'engine', 'run prepare:engine'].map((step) => ({
    step, token: 'fixture-installation-token', baseUrl: 'https://fixture.tellus.invalid',
  })));
  expect(result.stdout + result.stderr).not.toContain('fixture-installation-token');
});

it('prefers process environment credentials and an explicit artifact endpoint', () => {
  const result = runSetup('TELLUS_AUDIO_ENGINE_TOKEN=dotenv-fixture-token\nTELLUS_AUDIO_DOWNLOAD_BASE_URL=https://dotenv.tellus.invalid\n', {
    TELLUS_AUDIO_ENGINE_TOKEN: 'environment-fixture-token',
    TELLUS_AUDIO_DOWNLOAD_BASE_URL: 'https://environment.tellus.invalid',
  });
  expect(result.status).toBe(0);
  expect(result.calls.every((call) => call.token === 'environment-fixture-token'
    && call.baseUrl === 'https://environment.tellus.invalid')).toBe(true);
});

it.each([
  ['SETUP_CI_EXIT', ['ci']],
  ['SETUP_ENGINE_EXIT', ['ci', 'engine']],
])('stops setup after %s fails', (failureVariable, steps) => {
  const result = runSetup('TELLUS_AUDIO_ENGINE_TOKEN=fixture-installation-token\n', { [failureVariable]: '7' });
  expect(result.status).toBe(7);
  expect(result.calls.map((call) => call.step)).toEqual(steps);
});
