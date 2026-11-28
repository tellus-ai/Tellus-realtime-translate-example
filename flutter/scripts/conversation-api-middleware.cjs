// Runs in this example's development server (scripts/dev-server.mjs) on the Mac, not in the app. It
// holds the API key, so the key is not part of the app: the app calls these routes, and what it
// gets back for the WebSockets is an access token that opens one Conversation for 15 minutes.
//
// This is the part to replace with your own backend. It does not know who the caller is; a real
// backend decides that first, for example from its own login session. The server listens on the
// local network, so only callers on this computer are accepted unless TELLUS_EXAMPLE_API_CLIENTS
// lists another address (see clientAddress below).

const { isIP } = require('node:net');

const PREFIX = '/__tellus/api';
// A Conversation ID is a UUID. The narrow pattern also keeps `.` and `..` segments, which would
// make the forwarded URL point at another route, out of the path.
const ID = '[A-Za-z0-9_-]{1,128}';
// The only calls the app needs. Everything else the API key can do stays out of reach.
const ROUTES = [
  /^\/v1\/conversations$/,
  new RegExp(`^/v1/conversations/${ID}/settings$`),
  new RegExp(`^/v1/conversations/${ID}/end$`),
  /^\/v1\/access-tokens$/,
];
// The largest settings body that Tellus accepts.
const MAX_BODY_BYTES = 128_000;

/** The caller's IP address. A dual-stack server reports an IPv4 caller as `::ffff:192.168.0.12`. */
function clientAddress(request) {
  return normalizeAddress((request.socket && request.socket.remoteAddress) || '');
}
function normalizeAddress(address) {
  const value = address.trim();
  return value.startsWith('::ffff:') ? value.slice('::ffff:'.length) : value;
}
function isLoopback(address) {
  return address === '::1' || /^127\./.test(address);
}

/**
 * Whether `origin` is this server's own page. Its name must be an IP address or `localhost`: a page
 * on another domain can point its name at this computer (DNS rebinding), and its Origin then
 * matches Host. Browsers send Origin with every POST, so such a page cannot leave it out.
 */
function isOwnPage(origin, host) {
  try {
    const url = new URL(origin);
    const name = url.hostname.replace(/^\[|\]$/g, '');
    return url.host === host && (isIP(name) !== 0 || name === 'localhost' || name.endsWith('.localhost'));
  } catch {
    return false;
  }
}

function warnRefusedClient(address) {
  console.warn(`[tellus] Refused a Conversation API call from ${address}. To allow that device, add the address `
    + 'to TELLUS_EXAMPLE_API_CLIENTS in flutter/.env and restart the development server.');
}

/**
 * `allowedClients`: addresses besides this computer that may call, as an array or a comma-separated
 * string (TELLUS_EXAMPLE_API_CLIENTS). This computer itself, through loopback, is always allowed.
 */
function createConversationApiMiddleware({
  apiKey, httpBaseUrl, allowedClients = [], onRefusedClient = warnRefusedClient, timeoutMs = 15_000,
}) {
  const key = (apiKey || '').trim();
  const base = String(httpBaseUrl).replace(/\/+$/, '');
  const clients = new Set((Array.isArray(allowedClients) ? allowedClients : String(allowedClients).split(','))
    .map(normalizeAddress).filter(Boolean));
  const warned = new Set();

  return (request, response, next) => {
    const url = request.url || '';
    if (url !== PREFIX && !url.startsWith(`${PREFIX}/`) && !url.startsWith(`${PREFIX}?`)) return next();

    function reply(status, message) {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ message: [message] }));
    }
    // Anyone who reaches this server could otherwise spend the key, and a development server can be
    // reachable from the whole network. A simulator, an emulator, and `adb reverse` come in through
    // loopback. The check comes first, so a refused caller does not learn which routes exist.
    const client = clientAddress(request);
    if (!isLoopback(client) && !clients.has(client)) {
      if (!warned.has(client)) {
        warned.add(client);
        onRefusedClient(client);
      }
      return reply(403, `Only this computer and the addresses in TELLUS_EXAMPLE_API_CLIENTS may call this server (${client}).`);
    }
    // A query string is part of `path`, so a request with one matches no route.
    const path = url.slice(PREFIX.length);
    if (!ROUTES.some(route => route.test(path))) return reply(404, 'Not found.');
    if (request.method !== 'POST') return reply(405, 'POST is required.');
    // The custom header and same-origin check keep web pages from using this server's key. The app
    // passes because its HTTP client (dart:io) sends no Origin header.
    const origin = request.headers.origin;
    const sameOrigin = !origin || isOwnPage(origin, request.headers.host);
    if (!sameOrigin || request.headers['x-tellus-example-api'] !== '1') {
      return reply(403, 'This request is not allowed.');
    }
    if (!key) return reply(500, 'Set API_KEY in flutter/.env and restart the development server.');

    void (async () => {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size <= MAX_BODY_BYTES) chunks.push(chunk);
      }
      if (size > MAX_BODY_BYTES) return reply(413, `The request body must not exceed ${MAX_BODY_BYTES} bytes.`);

      let status;
      let contentType;
      let body;
      try {
        // Only the path and the body come from the app. The credential is always this server's.
        const answer = await fetch(base + path, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
          body: size > 0 ? Buffer.concat(chunks) : undefined,
          signal: AbortSignal.timeout(timeoutMs),
          // A redirect would send the key to a route outside ROUTES. It counts as no answer.
          redirect: 'error',
        });
        status = answer.status;
        contentType = answer.headers.get('content-type') || 'application/json';
        body = await answer.text();
      } catch (error) {
        // The app handles both like a request that got no response: Tellus may have applied it.
        return error && error.name === 'TimeoutError'
          ? reply(504, 'The speech server did not answer in time.')
          : reply(502, 'The speech server could not be reached.');
      }
      // The status and the body go back unchanged, so the app reads Tellus errors as they are.
      response.writeHead(status, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
      response.end(body);
    })().catch(() => {
      if (!response.headersSent) reply(500, 'The request could not be forwarded.');
    });
  };
}

module.exports = { createConversationApiMiddleware, CONVERSATION_API_PREFIX: PREFIX };
