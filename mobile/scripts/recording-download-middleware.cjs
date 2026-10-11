const { mkdir, open, unlink } = require('node:fs/promises');
const { homedir } = require('node:os');
const { join } = require('node:path');

// Runs on the Mac hosting the development server, not inside the browser or mobile app.
function createRecordingDownloadMiddleware({ homeDirectory = homedir() } = {}) {
  const directory = join(homeDirectory, 'download');
  return (request, response, next) => {
    const pathname = (request.url || '').split('?')[0];
    if (!pathname.startsWith('/__tellus/recordings/')) return next();

    function reply(status, body) {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(body));
    }
    if (request.method !== 'POST') return reply(405, { message: 'POST is required.' });
    // The custom header and same-origin check prevent writes from unrelated web pages.
    const origin = request.headers.origin;
    let sameOrigin = !origin;
    try { if (origin) sameOrigin = new URL(origin).host === request.headers.host; } catch {}
    if (!sameOrigin || request.headers['x-tellus-recording-download'] !== '1') {
      return reply(403, { message: 'Recording download request is not allowed.' });
    }
    if (request.headers['content-type'] !== 'audio/ogg') {
      return reply(415, { message: 'An audio/ogg recording is required.' });
    }
    const match = /^\/__tellus\/recordings\/(tellus-recording-[A-Za-z0-9-]+\.ogg)$/.exec(pathname);
    if (!match) return reply(400, { message: 'Invalid recording filename.' });
    const destination = join(directory, match[1]);

    void (async () => {
      await mkdir(directory, { recursive: true });
      const file = await open(destination, 'wx');
      try {
        for await (const chunk of request) await file.writeFile(chunk);
      } catch (error) {
        await file.close();
        await unlink(destination);
        throw error;
      }
      await file.close();
      reply(201, { path: destination });
    })().catch(error => {
      if (!response.destroyed) reply(error.code === 'EEXIST' ? 409 : 500, { message: error.message });
    });
  };
}

module.exports = { createRecordingDownloadMiddleware };
