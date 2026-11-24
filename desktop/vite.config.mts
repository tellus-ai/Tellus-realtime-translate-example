import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { configDefaults, defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { createConversationApiMiddleware } from './scripts/conversation-api-middleware.cjs';

const DEFAULT_HTTP_URL = 'https://public.speech.tellus.ai.kr';

function readDotenv(): Record<string, string | undefined> {
  try {
    return parseEnv(readFileSync(new URL('./.env', import.meta.url), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

/**
 * The example API server: the `npm run dev` server forwards the app's four Conversation calls to
 * Tellus with the API key (scripts/conversation-api-middleware.cjs). The key stays in this
 * process; it is not given to the renderer, the Electron main process, or the packaged app.
 */
function conversationApi(): Plugin {
  return {
    name: 'local-conversation-api',
    configureServer(server) {
      const env = { ...readDotenv(), ...process.env };
      server.middlewares.use(createConversationApiMiddleware({
        apiKey: env.API_KEY?.trim() ?? '',
        httpBaseUrl: env.REALTIME_SPEECH_HTTP_URL?.trim() || DEFAULT_HTTP_URL,
      }));
    },
  };
}

export default defineConfig({
  // The renderer never reads .env: `conversationApi` reads its two values itself.
  envDir: false,
  plugins: [react(), conversationApi()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
  },
  build: {
    outDir: 'dist/renderer',
    emptyOutDir: true,
  },
  test: {
    environment: 'node',
    exclude: [...configDefaults.exclude, '**/.sdk/**'],
  },
});
