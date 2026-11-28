const { mkdir, open, unlink } = require('node:fs/promises');
const { isIP } = require('node:net');
const { homedir } = require('node:os');
const { join } = require('node:path');

const normalizeAddress = address => address.trim().replace(/^::ffff:/, '');
const isLoopback = address => address === '::1' || /^127\./.test(address);

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

// An hour of the examples' 64 kb/s Opus is about 30 MB.
const MAX_RECORDING_BYTES = 100 * 1024 * 1024;

// Runs on the Mac hosting the development server, not inside the browser or mobile app.
// `allowedClients` (array or comma-separated string): when given, only this computer (loopback)
// and these addresses may save files. Without it any caller that reaches the server may.
function createRecordingDownloadMiddleware({ homeDirectory = homedir(), allowedClients, maxBytes = MAX_RECORDING_BYTES } = {}) {
  const directory = join(homeDirectory, 'download');
  const clients = allowedClients === undefined ? null
    : new Set((Array.isArray(allowedClients) ? allowedClients : String(allowedClients).split(','))
      .map(normalizeAddress).filter(Boolean));
  return (request, response, next) => {
    const pathname = (request.url || '').split('?')[0];
    if (!pathname.startsWith('/__tellus/recordings/')) return next();

    function reply(status, body) {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(body));
    }
    const client = normalizeAddress((request.socket && request.socket.remoteAddress) || '');
    if (clients && !isLoopback(client) && !clients.has(client)) {
      return reply(403, { message: `Only this computer and the addresses in TELLUS_EXAMPLE_API_CLIENTS may save recordings (${client}).` });
    }
    if (request.method !== 'POST') return reply(405, { message: 'POST is required.' });
    // The custom header and same-origin check prevent writes from unrelated web pages.
    const origin = request.headers.origin;
    const sameOrigin = !origin || isOwnPage(origin, request.headers.host);
    if (!sameOrigin || request.headers['x-tellus-recording-download'] !== '1') {
      return reply(403, { message: 'Recording download request is not allowed.' });
    }
    if (request.headers['content-type'] !== 'audio/ogg') {
      return reply(415, { message: 'An audio/ogg recording is required.' });
    }
    if (Number(request.headers['content-length']) > maxBytes) {
      return reply(413, { message: 'The recording is too large.' });
    }
    const match = /^\/__tellus\/recordings\/(tellus-recording-[A-Za-z0-9-]+\.ogg)$/.exec(pathname);
    if (!match) return reply(400, { message: 'Invalid recording filename.' });
    const destination = join(directory, match[1]);

    void (async () => {
      await mkdir(directory, { recursive: true });
      const file = await open(destination, 'wx');
      try {
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          if (size > maxBytes) throw Object.assign(new Error('The recording is too large.'), { code: 'TOO_LARGE' });
          await file.writeFile(chunk);
        }
      } catch (error) {
        await file.close();
        await unlink(destination);
        throw error;
      }
      await file.close();
      reply(201, { path: destination });
    })().catch(error => {
      if (!response.destroyed) reply(error.code === 'EEXIST' ? 409 : error.code === 'TOO_LARGE' ? 413 : 500, { message: error.message });
    });
  };
}

module.exports = { createRecordingDownloadMiddleware };
