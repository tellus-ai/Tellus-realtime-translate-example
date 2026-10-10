const DEFAULT_HTTP_URL = 'https://stgrtsapi.tellus.ai.kr';
const DEFAULT_WS_URL = 'wss://stgrtsapi.tellus.ai.kr';

function trimTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

export const realtimeSpeechConfig = {
  audioSdkEnabled: import.meta.env.VITE_TELLUS_AUDIO_SDK_ENABLED?.trim() !== 'false',
  accessToken: import.meta.env.VITE_ACCESS_TOKEN?.trim() ?? '',
  httpBaseUrl: trimTrailingSlash(
    import.meta.env.VITE_REALTIME_SPEECH_HTTP_URL || DEFAULT_HTTP_URL,
  ),
  websocketBaseUrl: trimTrailingSlash(
    import.meta.env.VITE_REALTIME_SPEECH_WS_URL || DEFAULT_WS_URL,
  ),
} as const;
