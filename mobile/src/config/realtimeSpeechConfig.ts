import Constants from 'expo-constants';

function configuredUrl(value: unknown, fallback: string): string {
  return (typeof value === 'string' && value.trim() ? value : fallback).trim().replace(/\/+$/, '');
}

const extra = Constants.expoConfig?.extra;

export const realtimeSpeechConfig = {
  accessToken: typeof extra?.accessToken === 'string' ? extra.accessToken.trim() : '',
  httpBaseUrl: configuredUrl(extra?.httpBaseUrl, 'https://stgrtsapi.tellus.ai.kr'),
  websocketBaseUrl: configuredUrl(extra?.websocketBaseUrl, 'wss://stgrtsapi.tellus.ai.kr'),
  appOrigin: configuredUrl(extra?.appOrigin, 'https://devapp.tellus.ai.kr'),
} as const;
