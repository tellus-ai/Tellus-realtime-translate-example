import Constants from 'expo-constants';

function configuredUrl(value: unknown, fallback: string): string {
  return (typeof value === 'string' && value.trim() ? value : fallback).trim().replace(/\/+$/, '');
}

const extra = Constants.expoConfig?.extra;

export const realtimeSpeechConfig = {
  audioSdkEnabled: extra?.audioSdkEnabled !== false,
  // Whether the Expo development server has an API key. The key itself stays on that server.
  apiKeyConfigured: extra?.apiKeyConfigured === true,
  // `TELLUS_EXAMPLE_API_URL`: a server with the four Conversation routes, for a build that does
  // not run against Metro. Empty: the app uses the Expo development server.
  exampleApiUrl: configuredUrl(extra?.exampleApiUrl, ''),
  websocketBaseUrl: configuredUrl(extra?.websocketBaseUrl, 'wss://public.speech.tellus.ai.kr'),
  appOrigin: configuredUrl(extra?.appOrigin, 'https://devapp.tellus.ai.kr'),
} as const;
