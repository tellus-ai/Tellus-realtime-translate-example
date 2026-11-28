import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { startDevServer } from './dev-server.mjs';
import { serverPort } from './env.mjs';

const API_KEY = 'tl_test_secret-key';
const CALLER = { 'Content-Type': 'application/json', 'X-Tellus-Example-Api': '1' };
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
const origin = server => `http://127.0.0.1:${server.address().port}`;

/** The development server with the given settings, on a free loopback port. */
async function start(t, env = {}) {
  const server = await startDevServer({ env, port: 0, host: '127.0.0.1' });
  t.after(() => close(server));
  return origin(server);
}

test('forwards a Conversation call to REALTIME_SPEECH_HTTP_URL with the API key of the settings', async t => {
  const calls = [];
  const tellus = createServer((request, response) => {
    calls.push({ method: request.method, path: request.url, authorization: request.headers.authorization });
    response.writeHead(201, { 'Content-Type': 'application/json' });
    response.end('{"data":{"conversation_id":"c-1"}}');
  });
  await new Promise(resolve => tellus.listen(0, '127.0.0.1', resolve));
  t.after(() => close(tellus));

  const app = await start(t, { API_KEY, REALTIME_SPEECH_HTTP_URL: ` ${origin(tellus)}/ ` });
  const response = await fetch(`${app}/__tellus/api/v1/conversations`, { method: 'POST', headers: CALLER });
  assert.equal(response.status, 201);
  assert.equal(await response.text(), '{"data":{"conversation_id":"c-1"}}');
  assert.deepEqual(calls, [{ method: 'POST', path: '/v1/conversations', authorization: `Bearer ${API_KEY}` }]);
});

test('reports a missing API_KEY on the Conversation routes', async t => {
  const app = await start(t);
  const response = await fetch(`${app}/__tellus/api/v1/conversations`, { method: 'POST', headers: CALLER });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { message: ['Set API_KEY in flutter/.env and restart the development server.'] });
});

test('mounts the recording download route', async t => {
  const app = await start(t);
  const endpoint = `${app}/__tellus/recordings/tellus-recording-test.ogg`;
  // Both are refused by the recording middleware itself, so nothing is written to ~/download.
  assert.equal((await fetch(endpoint)).status, 405);
  assert.equal((await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'audio/ogg' }, body: 'Ogg' })).status, 403);
});

test('answers 404 for every other path', async t => {
  const app = await start(t, { API_KEY });
  for (const [method, path] of [
    ['GET', '/'],
    ['GET', '/__tellus'],
    ['POST', '/v1/conversations'],
    ['POST', '/__tellus/api/v1/terminology'],
    ['POST', '/__tellus/recording/tellus-recording-test.ogg'],
  ]) {
    const response = await fetch(app + path, { method, headers: CALLER });
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.deepEqual(await response.json(), { message: ['Not found.'] });
  }
});

test('listens on TELLUS_EXAMPLE_SERVER_PORT, 8787 by default', () => {
  assert.equal(serverPort({}), 8787);
  assert.equal(serverPort({ TELLUS_EXAMPLE_SERVER_PORT: ' ' }), 8787);
  assert.equal(serverPort({ TELLUS_EXAMPLE_SERVER_PORT: '9090' }), 9090);
  for (const value of ['0', '65536', '87.5', 'http']) {
    assert.throws(() => serverPort({ TELLUS_EXAMPLE_SERVER_PORT: value }), /TELLUS_EXAMPLE_SERVER_PORT/, value);
  }
});
