import { RealtimeApiError, requestJson } from './httpClient';

export interface RealtimeEndpoints {
  audioSdkEnabled?: boolean;
  httpBaseUrl: string;
  websocketBaseUrl: string;
  appOrigin: string;
}

export interface StartConversationInput {
  sourceLanguage: string;
  targetLanguage: string;
  clientVad: boolean;
}

export async function createConversation(endpoints: RealtimeEndpoints, apiKey: string): Promise<string> {
  // No body: the settings are saved by the next call.
  const response = await requestJson<{ conversation_id: string }>(
    `${endpoints.httpBaseUrl}/v1/conversations`, apiKey, { method: 'POST' },
  );
  if (!response.conversation_id) throw new Error('Conversation response is missing conversation_id.');
  return response.conversation_id;
}

export async function saveInterpretationSettings(
  endpoints: RealtimeEndpoints,
  apiKey: string,
  conversationId: string,
  sourceLanguage: string,
  targetLanguage: string,
  clientVad: boolean,
): Promise<void> {
  await requestJson(
    `${endpoints.httpBaseUrl}/v1/conversations/${encodeURIComponent(conversationId)}/settings`,
    apiKey,
    { method: 'POST', body: JSON.stringify({ languages: [sourceLanguage, targetLanguage], transcription: { client_vad: clientVad } }) },
  );
}

/** Resolves once the Conversation is over, whether or not this call was the one that ended it. */
export async function endConversation(
  endpoints: RealtimeEndpoints,
  apiKey: string,
  conversationId: string,
): Promise<void> {
  try {
    await requestJson(
      `${endpoints.httpBaseUrl}/v1/conversations/${encodeURIComponent(conversationId)}/end`,
      apiKey,
      { method: 'POST' },
      { retryNetworkFailure: true },
    );
  } catch (error) {
    // 410: already ended. 404: gone or expired, so it can no longer be ended.
    if (error instanceof RealtimeApiError && (error.status === 410 || error.status === 404)) return;
    throw error;
  }
}

/**
 * `afterOrderSeq` is the last `order_seq` this client has handled in full. On connect the server
 * first sends the finals stored after it; without it, every stored final.
 */
export function buildResultWebSocketUrl(endpoints: RealtimeEndpoints, conversationId: string, afterOrderSeq: number | null = null): string {
  const url = `${endpoints.websocketBaseUrl}/v1/conversations/${encodeURIComponent(conversationId)}/results`;
  return afterOrderSeq === null ? url : `${url}?after_order_seq=${afterOrderSeq}`;
}

export function buildAudioWebSocketUrl(endpoints: RealtimeEndpoints, conversationId: string): string {
  return `${endpoints.websocketBaseUrl}/v1/audio?conversation_id=${encodeURIComponent(conversationId)}&audio_format=opus`;
}

/**
 * The handshake headers of both WebSockets. React Native can set them, so the app sends the API
 * key here. The server refuses a key in the URL, and a browser, which cannot set WebSocket
 * headers, connects with an access token from `POST /v1/access-tokens` instead.
 */
export function buildWebSocketHeaders(endpoints: RealtimeEndpoints, apiKey: string): Record<string, string> {
  return { Origin: endpoints.appOrigin, Authorization: `Bearer ${apiKey.trim()}` };
}
