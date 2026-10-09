import { loadEnv } from 'vite';
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '.', '');
  return {
    define: {
      'import.meta.env.VITE_ACCESS_TOKEN': JSON.stringify(env.API_KEY?.trim() ?? ''),
    },
    plugins: [react()],
    test: {
      environment: 'node',
    },
  };
});
