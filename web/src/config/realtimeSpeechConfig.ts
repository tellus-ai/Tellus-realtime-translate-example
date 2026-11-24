const DEFAULT_WS_URL = 'wss://public.speech.tellus.ai.kr';

function trimTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

export const realtimeSpeechConfig = {
  audioSdkEnabled: import.meta.env.VITE_TELLUS_AUDIO_SDK_ENABLED?.trim() !== 'false',
  // Whether the development server has an API key. The key itself stays on that server.
  apiKeyConfigured: import.meta.env.VITE_API_KEY_CONFIGURED === 'true',
  // Routes of the development server that call Tellus with the API key
  // (scripts/conversation-api-middleware.cjs). `VITE_REALTIME_SPEECH_HTTP_URL` is read there.
  apiBaseUrl: '/__tellus/api',
  websocketBaseUrl: trimTrailingSlash(
    import.meta.env.VITE_REALTIME_SPEECH_WS_URL || DEFAULT_WS_URL,
  ),
} as const;
