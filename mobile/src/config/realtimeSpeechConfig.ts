import Constants from 'expo-constants';

function configuredUrl(value: unknown, fallback: string): string {
  return (typeof value === 'string' && value.trim() ? value : fallback).trim().replace(/\/+$/, '');
}

const extra = Constants.expoConfig?.extra;

export const realtimeSpeechConfig = {
  audioSdkEnabled: extra?.audioSdkEnabled !== false,
  accessToken: typeof extra?.accessToken === 'string' ? extra.accessToken.trim() : '',
  httpBaseUrl: configuredUrl(extra?.httpBaseUrl, 'https://public.speech.tellus.ai.kr'),
  websocketBaseUrl: configuredUrl(extra?.websocketBaseUrl, 'wss://public.speech.tellus.ai.kr'),
  appOrigin: configuredUrl(extra?.appOrigin, 'https://devapp.tellus.ai.kr'),
} as const;
