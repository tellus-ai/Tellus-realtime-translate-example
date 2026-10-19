import { loadEnv } from 'vite';
import { configDefaults, defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import { createRecordingDownloadMiddleware } from './scripts/recording-download-middleware.cjs';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    define: {
      'import.meta.env.VITE_ACCESS_TOKEN': JSON.stringify(env.API_KEY?.trim() ?? ''),
    },
    plugins: [react(), {
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
