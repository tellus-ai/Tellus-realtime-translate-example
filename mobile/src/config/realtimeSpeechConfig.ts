import Constants from 'expo-constants';

function trimTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, '');
}

const configuredAccessToken = Constants.expoConfig?.extra?.accessToken;

export const realtimeSpeechConfig = {
  accessToken: typeof configuredAccessToken === 'string' ? configuredAccessToken.trim() : '',
  httpBaseUrl: trimTrailingSlash(
    process.env.EXPO_PUBLIC_REALTIME_SPEECH_HTTP_URL || 'https://stgrtsapi.tellus.ai.kr',
  ),
  websocketBaseUrl: trimTrailingSlash(
    process.env.EXPO_PUBLIC_REALTIME_SPEECH_WS_URL || 'wss://stgrtsapi.tellus.ai.kr',
  ),
  appOrigin: trimTrailingSlash(
    process.env.EXPO_PUBLIC_APP_ORIGIN || 'https://devapp.tellus.ai.kr',
  ),
} as const;
