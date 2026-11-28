const assert = require('node:assert/strict');
const { createServer, request: httpRequest } = require('node:http');
const { Readable } = require('node:stream');
const { test } = require('node:test');
const { createConversationApiMiddleware } = require('./conversation-api-middleware.cjs');

const API_KEY = 'tl_test_secret-key';
const CALLER = { 'Content-Type': 'application/json', 'X-Tellus-Example-Api': '1' };

function listen(handler) {
  const server = createServer(handler);
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}
const close = server => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); });
const origin = server => 'http://127.0.0.1:' + server.address().port;

/** A stand-in for the Tellus server. Tests script `answer` and read what arrived in `calls`. */
async function startTellus(t) {
  const tellus = { calls: [], answer: () => ({ status: 200, body: '{}' }) };
  tellus.server = await listen(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    tellus.calls.push({ method: request.method, path: request.url, authorization: request.headers.authorization, body });
    const answer = tellus.answer(request);
    if (!answer) return; // Never answers.
    response.writeHead(answer.status, { 'Content-Type': 'application/json', ...answer.headers });
    response.end(answer.body);
  });
  t.after(() => close(tellus.server));
  return tellus;
}

/** The development server with only this middleware. Everything it does not handle is a 404. */
async function startApp(t, options) {
  const middleware = createConversationApiMiddleware(options);
  const app = await listen((request, response) => middleware(request, response, () => {
    response.writeHead(404, { 'Content-Type': 'text/plain' });
    response.end('next');
  }));
  t.after(() => close(app));
  return origin(app);
}

async function start(t, overrides = {}) {
  const tellus = await startTellus(t);
  const app = await startApp(t, { apiKey: API_KEY, httpBaseUrl: origin(tellus.server), ...overrides });
  const post = (path, init = {}) => fetch(app + path, { method: 'POST', ...init, headers: { ...CALLER, ...init.headers } });
  return { tellus, app, post };
}

test('forwards the four Conversation calls with the API key and returns what Tellus answered', async t => {
  const { tellus, post } = await start(t);
  const settings = JSON.stringify({ languages: ['ko-KR', 'en-US'], transcription: { client_vad: false } });
  const token = JSON.stringify({ session_kind: 'conversation', session_id: 'c-1' });
  const answers = {
    '/v1/conversations': { status: 201, body: '{"statusCode":"201","message":["ok"],"data":{"conversation_id":"c-1"}}' },
    '/v1/conversations/c-1/settings': { status: 200, body: '{"statusCode":"200","message":["ok"],"data":{"revision":1}}' },
    '/v1/access-tokens': { status: 201, body: '{"access_token":"tl_at_ticket","expires_at_ms":1800000900000}' },
    '/v1/conversations/c-1/end': { status: 410, body: '{"statusCode":"410","message":["Conversation has already ended."],"data":{}}' },
  };
  tellus.answer = request => answers[request.url];

  for (const [path, body] of [
    ['/v1/conversations', undefined],
    ['/v1/conversations/c-1/settings', settings],
    ['/v1/access-tokens', token],
    ['/v1/conversations/c-1/end', undefined],
  ]) {
    const response = await post('/__tellus/api' + path, { body });
    assert.equal(response.status, answers[path].status, path);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(await response.text(), answers[path].body);
  }
  assert.deepEqual(tellus.calls, [
    { method: 'POST', path: '/v1/conversations', authorization: `Bearer ${API_KEY}`, body: '' },
    { method: 'POST', path: '/v1/conversations/c-1/settings', authorization: `Bearer ${API_KEY}`, body: settings },
    { method: 'POST', path: '/v1/access-tokens', authorization: `Bearer ${API_KEY}`, body: token },
    { method: 'POST', path: '/v1/conversations/c-1/end', authorization: `Bearer ${API_KEY}`, body: '' },
  ]);
});

test('uses its own API key, whatever credential the caller sends', async t => {
  const { tellus, post } = await start(t);
  await post('/__tellus/api/v1/conversations', { headers: { Authorization: 'Bearer from-the-browser', 'X-API-Key': 'from-the-browser' } });
  assert.equal(tellus.calls[0].authorization, `Bearer ${API_KEY}`);
});

test('never returns the API key to the caller', async t => {
  const { tellus, post } = await start(t);
  tellus.answer = () => ({ status: 401, body: '{"detail":"Invalid API key"}' });
  for (const response of [
    await post('/__tellus/api/v1/conversations'),
    await post('/__tellus/api/v1/unknown'),
    await fetch((await start(t, { httpBaseUrl: 'http://127.0.0.1:9' })).app + '/__tellus/api/v1/conversations', { method: 'POST', headers: CALLER }),
  ]) {
    const seen = JSON.stringify([...response.headers]) + await response.text();
    assert.equal(seen.includes(API_KEY), false);
  }
});

test('forwards nothing but those four calls', async t => {
  const { tellus, app, post } = await start(t);
  for (const path of [
    '/v1/terminology',
    '/v1/conversations/c-1',
    '/v1/conversations/c-1/results',
    '/v1/conversations/c-1/settings/extra',
    '/v1/conversations/c-1/end?force=1',
    '/v1/access-tokens/extra',
    '/v1/conversations//settings',
    '/conversations',
    '',
  ]) {
    assert.equal((await post('/__tellus/api' + path)).status, 404, path);
  }
  // A `..` or `%2e%2e` segment would make the forwarded URL point at another Tellus route.
  for (const id of ['..', '%2e%2e', '.', 'a%2Fb', 'a%20b']) {
    const status = await new Promise((resolve, reject) => {
      const { hostname, port } = new URL(app);
      httpRequest({ hostname, port, method: 'POST', path: `/__tellus/api/v1/conversations/${id}/settings`, headers: CALLER },
        response => { response.resume(); resolve(response.statusCode); }).on('error', reject).end();
    });
    assert.equal(status, 404, id);
  }
  assert.equal((await fetch(app + '/__tellus/api/v1/conversations', { headers: CALLER })).status, 405);
  assert.deepEqual(tellus.calls, []);
});

test('answers only this app: a request from another site, or without the example header, is refused', async t => {
  const { tellus, app, post } = await start(t);
  const path = '/__tellus/api/v1/conversations';
  assert.equal((await post(path, { headers: { Origin: 'https://unrelated.example' } })).status, 403);
  assert.equal((await fetch(app + path, { method: 'POST', headers: { 'Content-Type': 'application/json' } })).status, 403);
  // A form post from another page needs no CORS preflight. The header requirement stops it.
  assert.equal((await fetch(app + path, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 403);
  assert.deepEqual(tellus.calls, []);
  assert.equal((await post(path, { headers: { Origin: app } })).status, 200);
});

test('refuses a body larger than the settings limit without calling Tellus', async t => {
  const { tellus, post } = await start(t);
  assert.equal((await post('/__tellus/api/v1/conversations/c-1/settings', { body: 'x'.repeat(128_001) })).status, 413);
  assert.deepEqual(tellus.calls, []);
  assert.equal((await post('/__tellus/api/v1/conversations/c-1/settings', { body: 'x'.repeat(128_000) })).status, 200);
});

test('reports a missing API key as a configuration error and does not call Tellus', async t => {
  const { tellus, post } = await start(t, { apiKey: '  ' });
  const response = await post('/__tellus/api/v1/conversations');
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { message: ['Set API_KEY in desktop/.env and restart npm run dev.'] });
  assert.deepEqual(tellus.calls, []);
});

test('answers 502 when Tellus cannot be reached and 504 when it does not answer in time', async t => {
  const unreachable = await start(t, { httpBaseUrl: 'http://127.0.0.1:9' });
  const refused = await unreachable.post('/__tellus/api/v1/conversations');
  assert.equal(refused.status, 502);
  assert.deepEqual(await refused.json(), { message: ['The speech server could not be reached.'] });

  const slow = await start(t, { timeoutMs: 50 });
  slow.tellus.answer = () => null;
  const timedOut = await slow.post('/__tellus/api/v1/conversations/c-1/end');
  assert.equal(timedOut.status, 504);
  assert.deepEqual(await timedOut.json(), { message: ['The speech server did not answer in time.'] });
});

test('leaves every other path to the next handler', async t => {
  const { tellus, app } = await start(t);
  for (const path of ['/', '/__tellus/recordings/x.ogg', '/__tellus/apiv1/conversations', '/v1/conversations']) {
    const response = await fetch(app + path, { method: 'POST', headers: CALLER });
    assert.equal(await response.text(), 'next', path);
  }
  assert.deepEqual(tellus.calls, []);
});

/** Calls the middleware the way the server would for a caller at `remoteAddress`. */
function callFrom(middleware, remoteAddress, path = '/__tellus/api/v1/conversations') {
  return new Promise(resolve => {
    const request = Object.assign(Readable.from([]), {
      url: path, method: 'POST', headers: { host: 'dev.example', 'x-tellus-example-api': '1' }, socket: { remoteAddress },
    });
    const response = {
      headersSent: false,
      writeHead(status) { this.status = status; this.headersSent = true; },
      end(body) { resolve({ status: this.status, body: JSON.parse(body) }); },
    };
    middleware(request, response, () => resolve({ status: 'next' }));
  });
}

test('accepts calls only from this computer, unless TELLUS_EXAMPLE_API_CLIENTS lists the caller', async t => {
  const tellus = await startTellus(t);
  const refused = [];
  const options = { apiKey: API_KEY, httpBaseUrl: origin(tellus.server), onRefusedClient: address => refused.push(address) };
  const local = createConversationApiMiddleware(options);
  // A simulator, an emulator and `adb reverse` all reach the server through loopback.
  for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal((await callFrom(local, address)).status, 200, address);
  }
  // Another device on the network gets nothing, not even whether a route exists.
  for (const path of ['/__tellus/api/v1/conversations', '/__tellus/api/v1/terminology']) {
    const answer = await callFrom(local, '::ffff:192.168.0.12', path);
    assert.equal(answer.status, 403, path);
    assert.match(answer.body.message[0], /TELLUS_EXAMPLE_API_CLIENTS/);
  }
  // The server log names each refused address once.
  assert.deepEqual(refused, ['192.168.0.12']);
  assert.equal(tellus.calls.length, 3);

  const listed = createConversationApiMiddleware({ ...options, allowedClients: ' 192.168.0.12 , ::ffff:10.0.0.5,' });
  assert.equal((await callFrom(listed, '::ffff:192.168.0.12')).status, 200);
  assert.equal((await callFrom(listed, '10.0.0.5')).status, 200);
  assert.equal((await callFrom(listed, '192.168.0.13')).status, 403);
  // Other paths still pass to the next handler, whoever calls.
  assert.equal((await callFrom(listed, '192.168.0.13', '/index.html')).status, 'next');
});

/** A POST with headers that fetch() does not let a caller set, such as Host. */
function postAs(app, path, headers) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(app + path, { method: 'POST', headers: { ...CALLER, ...headers } }, response => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('error', reject);
    request.end('{}');
  });
}

test('refuses a page on another domain that points its name at this computer (DNS rebinding)', async t => {
  const { tellus, app } = await start(t);
  const { port } = new URL(app);
  // The browser sends that page's Origin, and Host carries the same name.
  for (const host of [`rebind.example:${port}`, `127.0.0.1.nip.io:${port}`]) {
    assert.equal(await postAs(app, '/__tellus/api/v1/access-tokens', { Host: host, Origin: `http://${host}` }), 403, host);
  }
  assert.deepEqual(tellus.calls, []);
  // This server's own page, named by localhost or an IP address, is still accepted.
  for (const host of [`localhost:${port}`, `[::1]:${port}`, `192.168.0.10:${port}`]) {
    assert.equal(await postAs(app, '/__tellus/api/v1/access-tokens', { Host: host, Origin: `http://${host}` }), 200, host);
  }
});

test('does not follow a redirect from Tellus, so the key reaches no other route', async t => {
  const { tellus, post } = await start(t);
  tellus.answer = () => ({ status: 307, headers: { Location: '/v1/api-keys' }, body: '' });
  const response = await post('/__tellus/api/v1/access-tokens', { body: '{}' });
  assert.equal(response.status, 502);
  assert.deepEqual(tellus.calls.map(call => call.path), ['/v1/access-tokens']);
});
