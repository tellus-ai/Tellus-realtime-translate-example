import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';

function runSetup(t, { dotenv = '', env = {}, failAt = '' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'tellus-mobile-setup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  writeFileSync(join(root, 'scripts/setup.mjs'), readFileSync(new URL('./setup.mjs', import.meta.url)));
  writeFileSync(join(root, '.env'), dotenv);
  const installer = join(root, 'node_modules/@tellus-ai/audio-sdk-mobile/dist/installer');
  mkdirSync(installer, { recursive: true });
  const child = `
    const { appendFileSync, mkdirSync, existsSync } = require('node:fs');
    const { join } = require('node:path');
    const step = __filename.endsWith('npm.cjs') ? 'npm' :
      __filename.endsWith('install-binary-cli.js') ? 'install' : 'check';
    appendFileSync('calls.jsonl', JSON.stringify({ step, args: process.argv.slice(2),
      token: process.env.TELLUS_AUDIO_ENGINE_TOKEN,
      baseUrl: process.env.TELLUS_AUDIO_DOWNLOAD_BASE_URL }) + '\\n');
    if (process.env.FAIL_AT === step) process.exit(7);
    if (step === 'install') for (const target of ['ios', 'android']) mkdirSync(join('assets', target), { recursive: true });
    if (step === 'check' && !['ios', 'android'].every(target => existsSync(join('assets', target)))) process.exit(9);
  `;
  writeFileSync(join(root, 'npm.cjs'), child);
  writeFileSync(join(installer, 'install-binary-cli.js'), child);
  writeFileSync(join(installer, 'check-binary-cli.js'), child);
  const result = spawnSync(process.execPath, [join(root, 'scripts/setup.mjs')], {
    cwd: root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, npm_execpath: join(root, 'npm.cjs'), FAIL_AT: failAt, ...env },
  });
  let calls = [];
  try { calls = readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line)); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return { ...result, calls };
}

test('rejects a missing installation token before npm runs even when API_KEY is set', t => {
  const result = runSetup(t, { dotenv: 'API_KEY=runtime-only\n' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /TELLUS_AUDIO_ENGINE_TOKEN/);
  assert.deepEqual(result.calls, []);
});

test('passes dotenv installation credentials through npm, SDK installation, and asset verification', t => {
  const result = runSetup(t, { dotenv: 'TELLUS_AUDIO_ENGINE_TOKEN="fixture-install-token"\nEXPO_PUBLIC_REALTIME_SPEECH_HTTP_URL=https://fixture.invalid\n' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.calls.map(({ step }) => step), ['npm', 'install', 'check']);
  assert.deepEqual(result.calls[0].args, ['ci', '--legacy-peer-deps']);
  assert.ok(result.calls.every(({ token, baseUrl }) => token === 'fixture-install-token' && baseUrl === 'https://fixture.invalid'));
  assert.doesNotMatch(result.stdout + result.stderr, /fixture-install-token/);
});

test('environment credentials override dotenv values', t => {
  const result = runSetup(t, {
    dotenv: 'TELLUS_AUDIO_ENGINE_TOKEN=dotenv-token\nTELLUS_AUDIO_DOWNLOAD_BASE_URL=https://dotenv.invalid\n',
    env: { TELLUS_AUDIO_ENGINE_TOKEN: 'environment-token', TELLUS_AUDIO_DOWNLOAD_BASE_URL: 'https://environment.invalid' },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.calls.every(({ token, baseUrl }) => token === 'environment-token' && baseUrl === 'https://environment.invalid'));
  assert.doesNotMatch(result.stdout + result.stderr, /environment-token/);
});

for (const [failAt, steps] of [['npm', ['npm']], ['install', ['npm', 'install']], ['check', ['npm', 'install', 'check']]]) {
  test(`propagates ${failAt} failure and stops setup`, t => {
    const result = runSetup(t, { env: { TELLUS_AUDIO_ENGINE_TOKEN: 'fixture-token' }, failAt });
    assert.equal(result.status, 7);
    assert.deepEqual(result.calls.map(({ step }) => step), steps);
  });
}


test('dev verifies the dotenv-selected platform without reinstalling valid assets', t => {
  const root = mkdtempSync(join(tmpdir(), 'tellus-mobile-dev-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'dev.sh'), readFileSync(new URL('../dev.sh', import.meta.url)));
  writeFileSync(join(root, '.env'), 'API_KEY=fixture-runtime\nTELLUS_AUDIO_ENGINE_PLATFORM=android\n');
  const installer = join(root, 'node_modules/@tellus-ai/audio-sdk-mobile/dist/installer');
  mkdirSync(installer, { recursive: true });
  writeFileSync(join(installer, 'check-binary-cli.js'), `
    const { writeFileSync } = require('node:fs');
    if (process.env.TELLUS_AUDIO_ENGINE_PLATFORM !== 'android') process.exit(1);
    writeFileSync('checked-platform', process.env.TELLUS_AUDIO_ENGINE_PLATFORM);
  `);
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin/npm'), '#!/bin/sh\nprintf "%s\\n" "$*" >> calls.txt\n');
  chmodSync(join(root, 'bin/npm'), 0o755);
  const result = spawnSync('/bin/bash', [join(root, 'dev.sh')], {
    cwd: root, encoding: 'utf8', env: { PATH: `${join(root, 'bin')}:${process.env.PATH}` },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(root, 'checked-platform'), 'utf8'), 'android');
  assert.deepEqual(readFileSync(join(root, 'calls.txt'), 'utf8').trim().split('\n'), [
    'ls @tellus-ai/audio-sdk-mobile --depth=0', 'run start --',
  ]);
});
