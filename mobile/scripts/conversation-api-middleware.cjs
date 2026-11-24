// Runs in the Expo (Metro) development server on the Mac, not in the app. It holds the API key, so
// the key is not part of the app: the app calls these routes, and what it gets back for the
// WebSockets is an access token that opens one Conversation for 15 minutes.
//
// This is the part to replace with your own backend. It does not know who the caller is; a real
// backend decides that first, for example from its own login session. Metro listens on the local
// network, so anyone who can reach its port can start Conversations on the key (but not read it).

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

function createConversationApiMiddleware({ apiKey, httpBaseUrl, timeoutMs = 15_000 }) {
  const key = (apiKey || '').trim();
  const base = String(httpBaseUrl).replace(/\/+$/, '');

  return (request, response, next) => {
    const url = request.url || '';
    if (url !== PREFIX && !url.startsWith(`${PREFIX}/`) && !url.startsWith(`${PREFIX}?`)) return next();

    function reply(status, message) {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ message: [message] }));
    }
    // A query string is part of `path`, so a request with one matches no route.
    const path = url.slice(PREFIX.length);
    if (!ROUTES.some(route => route.test(path))) return reply(404, 'Not found.');
    if (request.method !== 'POST') return reply(405, 'POST is required.');
    // The custom header and same-origin check keep web pages from using this server's key. The app
    // passes because React Native's fetch sends no Origin header.
    const origin = request.headers.origin;
    let sameOrigin = !origin;
    try { if (origin) sameOrigin = new URL(origin).host === request.headers.host; } catch {}
    if (!sameOrigin || request.headers['x-tellus-example-api'] !== '1') {
      return reply(403, 'This request is not allowed.');
    }
    if (!key) return reply(500, 'Set API_KEY in mobile/.env and restart the Expo development server.');

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
