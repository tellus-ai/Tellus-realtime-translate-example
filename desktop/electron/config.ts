import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const DEFAULT_HTTP_URL = 'https://stgrtsapi.tellus.ai.kr';
const DEFAULT_WS_URL = 'wss://stgrtsapi.tellus.ai.kr';
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export interface RealtimeSpeechConfig {
  accessToken: string;
  httpBaseUrl: string;
  websocketBaseUrl: string;
}

export function readEnvFile(path: string): Record<string, string> {
  try {
    return parseEnv(readFileSync(path, 'utf8')) as Record<string, string>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

export function resolveRealtimeSpeechConfig(
  env: Readonly<Record<string, string | undefined>>,
): RealtimeSpeechConfig {
  return {
    accessToken: env.API_KEY?.trim() ?? '',
    httpBaseUrl: readBaseUrl('REALTIME_SPEECH_HTTP_URL', env.REALTIME_SPEECH_HTTP_URL, DEFAULT_HTTP_URL, 'https:', 'http:'),
    websocketBaseUrl: readBaseUrl('REALTIME_SPEECH_WS_URL', env.REALTIME_SPEECH_WS_URL, DEFAULT_WS_URL, 'wss:', 'ws:'),
  };
}

function readBaseUrl(
  name: string,
  value: string | undefined,
  fallback: string,
  secureProtocol: string,
  localProtocol: string,
): string {
  const baseUrl = (value?.trim() || fallback).replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`${name} is not a valid URL: ${baseUrl}`);
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must not contain credentials, a query, or a hash.`);
  }
  // The access token is sent with every REST request, so plain-text transport is limited to local servers.
  const local = url.protocol === localProtocol && LOCAL_HOSTNAMES.has(url.hostname);
  if (url.protocol !== secureProtocol && !local) {
    throw new Error(`${name} must use ${secureProtocol} (${localProtocol} is allowed only for localhost).`);
  }
  return baseUrl;
}
