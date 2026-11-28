import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { test } from 'node:test';

// Stand-ins for `adb` and `flutter` on PATH. Flutter's records what it was started with and what the
// development server answers while it runs, then exits like a failed `flutter run`.
const ADB = `#!${process.execPath}
require('node:fs').appendFileSync(process.env.CALLS, JSON.stringify({ tool: 'adb', args: process.argv.slice(2) }) + '\\n');
process.exit(1); // No device. The start must go on.
`;
const FLUTTER = `#!${process.execPath}
const { appendFileSync, readFileSync } = require('node:fs');
const defines = JSON.parse(readFileSync('.dart-defines.json', 'utf8'));
fetch(defines.TELLUS_EXAMPLE_SERVER_URL + '/__tellus/api/v1/conversations', { method: 'POST', headers: { 'X-Tellus-Example-Api': '1' } })
  .then(async response => {
    appendFileSync(process.env.CALLS, JSON.stringify({ tool: 'flutter', args: process.argv.slice(2), cwd: process.cwd(),
      defines, status: response.status, body: await response.text() }) + '\\n');
    process.exit(3);
  });
`;

async function freePort() {
  const server = createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

test('writes the dart defines, serves while Flutter runs, and exits with Flutter', async t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'tellus-flutter-run-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'scripts'));
  for (const script of ['run.mjs', 'dart-defines.mjs', 'dev-server.mjs', 'env.mjs', 'conversation-api-middleware.cjs', 'recording-download-middleware.cjs']) {
    copyFileSync(new URL(script, import.meta.url), join(root, 'scripts', script));
  }
  const port = await freePort();
  // Nothing listens on port 9, so a forwarded call ends as 502 without leaving this computer.
  writeFileSync(join(root, '.env'), `API_KEY=tl_test_marker-api-key\nREALTIME_SPEECH_HTTP_URL=http://127.0.0.1:9\nTELLUS_EXAMPLE_SERVER_PORT=${port}\n`);
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin/adb'), ADB, { mode: 0o755 });
  writeFileSync(join(root, 'bin/flutter'), FLUTTER, { mode: 0o755 });

  const run = spawn(process.execPath, [join(root, 'scripts/run.mjs'), '-d', 'fixture-device'], {
    cwd: tmpdir(), stdio: 'ignore', timeout: 30_000,
    env: { PATH: join(root, 'bin') + delimiter + process.env.PATH, CALLS: join(root, 'calls.jsonl') },
  });
  // The process ends only if the server stops when Flutter exits.
  const [status] = await new Promise(resolve => run.on('exit', (...result) => resolve(result)));
  assert.equal(status, 3);

  const calls = readFileSync(join(root, 'calls.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
  assert.deepEqual(calls, [
    { tool: 'adb', args: ['reverse', `tcp:${port}`, `tcp:${port}`] },
    {
      tool: 'flutter',
      args: ['run', '--dart-define-from-file=.dart-defines.json', '-d', 'fixture-device'],
      cwd: root,
      defines: {
        TELLUS_API_KEY_CONFIGURED: 'true',
        TELLUS_EXAMPLE_SERVER_URL: `http://localhost:${port}`,
        TELLUS_EXAMPLE_API_URL: '',
        REALTIME_SPEECH_WS_URL: '',
        APP_ORIGIN: '',
        TELLUS_DENOISE: 'false',
      },
      status: 502,
      body: '{"message":["The speech server could not be reached."]}',
    },
  ]);
});
