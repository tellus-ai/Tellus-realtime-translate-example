import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

const DEFAULT_WS_URL = 'wss://public.speech.tellus.ai.kr';
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
// The routes of scripts/conversation-api-middleware.cjs on the `npm run dev` server.
const DEV_SERVER_API_PATH = '__tellus/api';

/**
 * What the main process reads. There is no API key here: the example API server holds it and
 * gives this app an access token for each Conversation.
 */
export interface RealtimeSpeechConfig {
  audioSdkEnabled: boolean;
  websocketBaseUrl: string;
  /** `TELLUS_EXAMPLE_API_URL`: your server with the four Conversation routes. Null when unset. */
  exampleApiUrl: string | null;
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
  const exampleApiUrl = env.TELLUS_EXAMPLE_API_URL?.trim();
  return {
    audioSdkEnabled: env.TELLUS_AUDIO_SDK_ENABLED?.trim() !== 'false',
    websocketBaseUrl: readBaseUrl('REALTIME_SPEECH_WS_URL', env.REALTIME_SPEECH_WS_URL, DEFAULT_WS_URL, 'wss:', 'ws:'),
    exampleApiUrl: exampleApiUrl
      ? readBaseUrl('TELLUS_EXAMPLE_API_URL', exampleApiUrl, exampleApiUrl, 'https:', 'http:')
      : null,
  };
}

/**
 * The server the app sends its Conversation calls to: `TELLUS_EXAMPLE_API_URL` when it is set,
 * otherwise the `npm run dev` server. Null when there is neither, as in a packaged app without
 * `TELLUS_EXAMPLE_API_URL`.
 */
export function resolveExampleApiUrl(exampleApiUrl: string | null, devServerUrl: string | null): string | null {
  if (exampleApiUrl) return exampleApiUrl;
  return devServerUrl ? new URL(DEV_SERVER_API_PATH, devServerUrl).href : null;
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
  // The access token travels with every WebSocket handshake, and the Conversation calls with
  // every request to the example API server, so plain-text transport is limited to local servers.
  const local = url.protocol === localProtocol && LOCAL_HOSTNAMES.has(url.hostname);
  if (url.protocol !== secureProtocol && !local) {
    throw new Error(`${name} must use ${secureProtocol} (${localProtocol} is allowed only for localhost).`);
  }
  return baseUrl;
}
