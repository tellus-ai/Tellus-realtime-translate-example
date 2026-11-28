const assert = require('node:assert/strict');
const { createServer, request: httpRequest } = require('node:http');
const { Readable } = require('node:stream');
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

test('with allowedClients, saves only for this computer and the listed addresses', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tellus-host-download-'));
  try {
    const writer = createRecordingDownloadMiddleware({ homeDirectory: root, allowedClients: ' 192.168.0.12 ,' });
    const call = remoteAddress => new Promise(resolve => {
      const request = Object.assign(Readable.from([Buffer.from('OggS')]), {
        url: `/__tellus/recordings/tellus-recording-${remoteAddress.replace(/[^0-9]/g, '')}.ogg`, method: 'POST',
        headers: { host: 'dev.example', 'content-type': 'audio/ogg', 'x-tellus-recording-download': '1' }, socket: { remoteAddress },
      });
      const response = { writeHead(status) { this.status = status; }, end() { resolve(this.status); } };
      writer(request, response, () => resolve('next'));
    });
    assert.equal(await call('::ffff:192.168.0.13'), 403);
    assert.equal(await call('10.0.0.5'), 403);
    assert.equal(await call('127.0.0.1'), 201);
    assert.equal(await call('::1'), 201);
    assert.equal(await call('::ffff:192.168.0.12'), 201);
    assert.deepEqual((await readdir(join(root, 'download'))).sort(),
      ['tellus-recording-1.ogg', 'tellus-recording-127001.ogg', 'tellus-recording-192168012.ogg']);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses a page on another domain that points its name at this computer (DNS rebinding)', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tellus-host-download-'));
  const writer = createRecordingDownloadMiddleware({ homeDirectory: root });
  const server = createServer((request, response) => writer(request, response, () => {
    response.writeHead(404); response.end();
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const { port } = server.address();
  const post = (name, host) => new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: '127.0.0.1', port, method: 'POST', path: `/__tellus/recordings/${name}`, headers: {
      Host: host, Origin: `http://${host}`, 'Content-Type': 'audio/ogg', 'X-Tellus-Recording-Download': '1',
    } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
    request.end('OggS');
  });
  assert.equal(await post('tellus-recording-rebind.ogg', `rebind.example:${port}`), 403);
  assert.equal(await post('tellus-recording-local.ogg', `localhost:${port}`), 201);
  assert.deepEqual(await readdir(join(root, 'download')), ['tellus-recording-local.ogg']);
});

test('refuses a recording over maxBytes and keeps nothing of it', async t => {
  const root = await mkdtemp(join(tmpdir(), 'tellus-host-download-'));
  const writer = createRecordingDownloadMiddleware({ homeDirectory: root, maxBytes: 8 });
  const server = createServer((request, response) => writer(request, response, () => { response.writeHead(404); response.end(); }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + server.address().port;
  const headers = { 'Content-Type': 'audio/ogg', 'X-Tellus-Recording-Download': '1' };

  // Declared too large: refused before anything is written.
  const declared = await fetch(base + '/__tellus/recordings/tellus-recording-a.ogg', { method: 'POST', headers, body: new Uint8Array(9) });
  assert.equal(declared.status, 413);
  // Streamed without a length: cut off once it passes the limit, and the partial file is removed.
  const streamed = await new Promise((resolve, reject) => {
    const request = httpRequest(base + '/__tellus/recordings/tellus-recording-b.ogg', { method: 'POST', headers },
      response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject);
    request.write(new Uint8Array(6));
    request.end(new Uint8Array(6));
  });
  assert.equal(streamed, 413);
  const exact = await fetch(base + '/__tellus/recordings/tellus-recording-c.ogg', { method: 'POST', headers, body: new Uint8Array(8) });
  assert.equal(exact.status, 201);
  assert.deepEqual(await readdir(join(root, 'download')), ['tellus-recording-c.ogg']);
});
