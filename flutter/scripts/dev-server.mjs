// This example's development server: what Metro is for the Expo example. It runs on the Mac, holds
// the API key for the app's four Conversation calls, and saves downloaded recordings in ~/download.
//
//   node scripts/dev-server.mjs      (`npm start` runs the same server next to `flutter run`)
import { createServer } from 'node:http';
import { createConversationApiMiddleware } from './conversation-api-middleware.cjs';
import { readEnv, serverPort } from './env.mjs';
import { createRecordingDownloadMiddleware } from './recording-download-middleware.cjs';

const DEFAULT_HTTP_URL = 'https://public.speech.tellus.ai.kr';

/** The two middlewares in a row. Every other path is a 404. */
export function createDevServer(env) {
  const conversationApi = createConversationApiMiddleware({
    apiKey: env.API_KEY ?? '',
    httpBaseUrl: env.REALTIME_SPEECH_HTTP_URL?.trim() || DEFAULT_HTTP_URL,
    allowedClients: env.TELLUS_EXAMPLE_API_CLIENTS ?? '',
  });
  // The same devices as for the API key: anyone else on the network could fill the disk.
  const downloads = createRecordingDownloadMiddleware({ allowedClients: env.TELLUS_EXAMPLE_API_CLIENTS ?? '' });
  return createServer((request, response) => conversationApi(request, response,
    () => downloads(request, response, () => {
      response.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ message: ['Not found.'] }));
    })));
}

/**
 * Starts the server and resolves with it once it accepts calls. Without `host` it listens on every
 * interface, like Metro, so that a device on the network can reach it. Who may spend the API key is
 * decided for each call by the Conversation middleware: this computer, and the addresses in
 * TELLUS_EXAMPLE_API_CLIENTS.
 */
export function startDevServer({ env = readEnv(), port = serverPort(env), host } = {}) {
  const server = createDevServer(env);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port, host }, () => resolve(server));
  });
}

if (import.meta.main) {
  const server = await startDevServer();
  console.log(`[tellus] Development server: http://localhost:${server.address().port}`);
}
