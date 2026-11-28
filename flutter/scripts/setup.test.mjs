import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';

const REVISION = 'f'.repeat(40);

// One stand-in for every program that setup runs: `git` and `flutter` on PATH, npm through
// npm_execpath, and the two installer CLIs, which the SDK build creates. It records the call, then
// does the little that the following steps depend on.
const STAND_IN = `#!${process.execPath}
const { appendFileSync, copyFileSync, existsSync, mkdirSync, writeFileSync } = require('node:fs');
const { basename, join } = require('node:path');
const tool = basename(__filename).replace(/\\..*$/, '');
const args = process.argv.slice(2);
const step = [tool, ...args].join(' ');
appendFileSync(process.env.CALLS, JSON.stringify({ step, cwd: process.cwd(),
  token: process.env.TELLUS_AUDIO_ENGINE_TOKEN, baseUrl: process.env.TELLUS_AUDIO_DOWNLOAD_BASE_URL }) + '\\n');
if (process.env.FAIL_AT && step.startsWith(process.env.FAIL_AT)) process.exit(7);
if (step.startsWith('git clone')) mkdirSync(args.at(-1));
if (step === 'git rev-parse HEAD') console.log(process.env.CHECKED_OUT_REVISION);
if (step === 'npm run build') {
  mkdirSync('platforms/flutter/dist/installer', { recursive: true });
  for (const cli of ['install-binary-cli.js', 'check-binary-cli.js']) copyFileSync(__filename, join('platforms/flutter/dist/installer', cli));
}
if (tool === 'install-binary-cli') writeFileSync(join(__dirname, 'engine-ready'), 'installed');
if (tool === 'check-binary-cli' && !existsSync(join(__dirname, 'engine-ready'))) process.exit(9);
`;

function runSetup(t, { dotenv = '', env = {}, failAt = '', revision = REVISION, sdk = false } = {}) {
  // Node reports the real path as the working directory, and macOS keeps its temporary directory behind a link.
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tellus-flutter-setup-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  for (const script of ['setup.mjs', 'prepare-sdk.mjs', 'env.mjs']) {
    copyFileSync(new URL(script, import.meta.url), join(root, 'scripts', script));
  }
  writeFileSync(join(root, 'scripts/audio-sdk-release.json'), JSON.stringify({ sdkVersion: '1.2.3', sdkRevision: REVISION }));
  writeFileSync(join(root, '.env'), dotenv);
  if (sdk) mkdirSync(join(root, '.sdk'));
  mkdirSync(join(root, 'bin'));
  for (const program of ['bin/git', 'bin/flutter', 'npm.cjs']) writeFileSync(join(root, program), STAND_IN, { mode: 0o755 });

  const result = spawnSync(process.execPath, [join(root, 'scripts/setup.mjs')], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: join(root, 'bin') + delimiter + process.env.PATH, npm_execpath: join(root, 'npm.cjs'),
      CALLS: join(root, 'calls.jsonl'), FAIL_AT: failAt, CHECKED_OUT_REVISION: revision, ...env,
    },
  });
  let calls = [];
  try { calls = readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  // `<app>` stands for the example folder in the recorded steps and working directories.
  const inApp = text => text.replaceAll(root, '<app>');
  return { ...result, calls, steps: calls.map(({ step }) => inApp(step)), directories: calls.map(({ cwd }) => inApp(cwd)) };
}

const STEPS = [
  'git clone --depth 1 --branch v1.2.3 https://github.com/tellus-ai/tellus-audio-sdk.git <app>/.sdk/',
  'git rev-parse HEAD',
  'npm ci --ignore-scripts',
  'npm run build',
  'install-binary-cli',
  'check-binary-cli',
  'flutter pub get',
];

test('rejects a missing installation token before anything runs even when API_KEY is set', t => {
  const result = runSetup(t, { dotenv: 'API_KEY=runtime-only\n' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TELLUS_AUDIO_ENGINE_TOKEN/);
  assert.deepEqual(result.calls, []);
});

test('prepares the pinned SDK, installs and checks the engine, then links the plugin', t => {
  const result = runSetup(t, { dotenv: 'TELLUS_AUDIO_ENGINE_TOKEN="fixture-install-token"\nREALTIME_SPEECH_HTTP_URL=https://fixture.invalid\n' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.steps, STEPS);
  // The SDK is built in its checkout. The installer and Flutter run in the example.
  assert.deepEqual(result.directories, ['<app>', '<app>/.sdk', '<app>/.sdk', '<app>/.sdk', '<app>', '<app>', '<app>']);
  assert.ok(result.calls.slice(4, 6).every(({ token, baseUrl }) => token === 'fixture-install-token' && baseUrl === 'https://fixture.invalid'));
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-install-token/);
});

test('reuses an existing .sdk checkout', t => {
  const result = runSetup(t, { env: { TELLUS_AUDIO_ENGINE_TOKEN: 'fixture-token' }, sdk: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.steps, STEPS.slice(1));
});

test('rejects another SDK revision before anything is built or installed', t => {
  const result = runSetup(t, { env: { TELLUS_AUDIO_ENGINE_TOKEN: 'fixture-token' }, revision: '0'.repeat(40) });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /SDK revision mismatch/);
  assert.deepEqual(result.steps, STEPS.slice(0, 2));
});

test('environment credentials override dotenv values', t => {
  const result = runSetup(t, {
    dotenv: 'TELLUS_AUDIO_ENGINE_TOKEN=dotenv-token\nTELLUS_AUDIO_DOWNLOAD_BASE_URL=https://dotenv.invalid\nREALTIME_SPEECH_HTTP_URL=https://realtime.invalid\n',
    env: { TELLUS_AUDIO_ENGINE_TOKEN: 'environment-token', TELLUS_AUDIO_DOWNLOAD_BASE_URL: 'https://environment.invalid' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.calls.slice(4, 6).every(({ token, baseUrl }) => token === 'environment-token' && baseUrl === 'https://environment.invalid'));
  assert.doesNotMatch(result.stdout + result.stderr, /environment-token/);
});

for (const [failAt, count] of [['git clone', 1], ['npm ci', 3], ['npm run build', 4], ['install-binary-cli', 5], ['check-binary-cli', 6], ['flutter pub get', 7]]) {
  test(`propagates a ${failAt} failure and stops setup`, t => {
    const result = runSetup(t, { env: { TELLUS_AUDIO_ENGINE_TOKEN: 'fixture-token' }, failAt });
    assert.equal(result.status, 7);
    assert.deepEqual(result.steps, STEPS.slice(0, count));
  });
}
