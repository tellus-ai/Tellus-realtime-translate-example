const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { mkdtemp, readFile, readdir, rm } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { test } = require('node:test');
const { createRecordingDownloadMiddleware } = require('./recording-download-middleware.cjs');

test('local writer saves only inside ~/download and preserves existing files', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tellus-host-download-'));
  const writer = createRecordingDownloadMiddleware({ homeDirectory: root });
  const server = createServer((request, response) => writer(request, response, () => {
    response.writeHead(404); response.end();
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const endpoint = base + '/__tellus/recordings/tellus-recording-test.ogg';
  const headers = { 'Content-Type': 'audio/ogg', 'X-Tellus-Recording-Download': '1' };
  const bytes = new Uint8Array([79, 103, 103, 83, 0, 255, 128]);

  const saved = await fetch(endpoint, { method: 'POST', headers: { ...headers, Origin: base }, body: bytes });
  assert.equal(saved.status, 201);
  assert.deepEqual(await saved.json(), { path: join(root, 'download', 'tellus-recording-test.ogg') });
  assert.deepEqual([...await readFile(join(root, 'download', 'tellus-recording-test.ogg'))], [...bytes]);

  const duplicate = await fetch(endpoint, { method: 'POST', headers, body: new Uint8Array([1]) });
  assert.equal(duplicate.status, 409);
  assert.deepEqual([...await readFile(join(root, 'download', 'tellus-recording-test.ogg'))], [...bytes]);

  assert.equal((await fetch(base + '/__tellus/recordings/..%2Foutside.ogg', { method: 'POST', headers, body: bytes })).status, 400);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'audio/ogg' }, body: bytes })).status, 403);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...headers, Origin: 'https://unrelated.example' }, body: bytes })).status, 403);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { ...headers, 'Content-Type': 'text/plain' }, body: bytes })).status, 415);
  assert.equal((await fetch(endpoint)).status, 405);
  assert.equal((await fetch(base + '/unrelated')).status, 404);
  assert.deepEqual(await readdir(join(root, 'download')), ['tellus-recording-test.ogg']);
});
