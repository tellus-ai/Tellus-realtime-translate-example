import { loadEnv } from 'vite';
import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { createConversationApiMiddleware } from './scripts/conversation-api-middleware.cjs';
import { createRecordingDownloadMiddleware } from './scripts/recording-download-middleware.cjs';

const DEFAULT_HTTP_URL = 'https://public.speech.tellus.ai.kr';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  const apiKey = env.API_KEY?.trim() ?? '';
  // The API key stays in this server process. The browser bundle only learns whether one is set.
  const conversationApi = () => createConversationApiMiddleware({
    apiKey,
    httpBaseUrl: env.VITE_REALTIME_SPEECH_HTTP_URL || DEFAULT_HTTP_URL,
    // Only this computer may call, unless listed here (for `vite --host`).
    allowedClients: env.TELLUS_EXAMPLE_API_CLIENTS ?? '',
  });
  return {
    define: {
      'import.meta.env.VITE_API_KEY_CONFIGURED': JSON.stringify(String(Boolean(apiKey))),
    },
    plugins: [react(), {
      name: 'local-conversation-api',
      configureServer(server) { server.middlewares.use(conversationApi()); },
      configurePreviewServer(server) { server.middlewares.use(conversationApi()); },
    }, {
      name: 'local-recording-downloads',
      configureServer(server) { server.middlewares.use(createRecordingDownloadMiddleware()); },
      configurePreviewServer(server) { server.middlewares.use(createRecordingDownloadMiddleware()); },
    }],
    test: {
      environment: 'node',
      exclude: [...configDefaults.exclude, '**/.sdk/**'],
    },
  };
});
