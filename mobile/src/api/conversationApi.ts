import { RealtimeApiError, requestJson } from './httpClient';

export interface RealtimeEndpoints {
  audioSdkEnabled?: boolean;
  /**
   * This example's own server routes. They forward the calls below to Tellus with the API key, so
   * that the key is never in the app. Empty when no such server is known.
   */
  apiBaseUrl: string;
  /** Tellus itself. The app opens the WebSockets directly, with an access token. */
  websocketBaseUrl: string;
  appOrigin: string;
}

export interface StartConversationInput {
  sourceLanguage: string;
  targetLanguage: string;
  clientVad: boolean;
}

export interface IssuedAccessToken {
  token: string;
  /** Epoch milliseconds. A token lasts 15 minutes. */
  expiresAtMs: number;
}

export async function createConversation(endpoints: RealtimeEndpoints): Promise<string> {
  // No body: the settings are saved by the next call.
  const response = await requestJson<{ conversation_id: string }>(
    `${endpoints.apiBaseUrl}/v1/conversations`, { method: 'POST' },
  );
  if (!response.conversation_id) throw new Error('Conversation response is missing conversation_id.');
  return response.conversation_id;
}

export async function saveInterpretationSettings(
  endpoints: RealtimeEndpoints,
  conversationId: string,
  sourceLanguage: string,
  targetLanguage: string,
  clientVad: boolean,
): Promise<void> {
  await requestJson(
    `${endpoints.apiBaseUrl}/v1/conversations/${encodeURIComponent(conversationId)}/settings`,
    { method: 'POST', body: JSON.stringify({ languages: [sourceLanguage, targetLanguage], transcription: { client_vad: clientVad } }) },
  );
}

/**
 * Asks this example's server for an access token that opens the WebSockets of one Conversation.
 * The token is the only credential the app ever holds.
 */
export async function issueAccessToken(endpoints: RealtimeEndpoints, conversationId: string): Promise<IssuedAccessToken> {
  const response = await requestJson<{ access_token?: string; expires_at_ms?: number }>(
    `${endpoints.apiBaseUrl}/v1/access-tokens`,
    { method: 'POST', body: JSON.stringify({ session_kind: 'conversation', session_id: conversationId }) },
    // Issuing again is harmless: a token is not stored on the server.
    { retryNetworkFailure: true },
  );
  if (!response.access_token || !Number.isFinite(response.expires_at_ms)) {
    throw new Error('Access token response is missing access_token or expires_at_ms.');
  }
  return { token: response.access_token, expiresAtMs: response.expires_at_ms as number };
}

/** Resolves once the Conversation is over, whether or not this call was the one that ended it. */
export async function endConversation(endpoints: RealtimeEndpoints, conversationId: string): Promise<void> {
  try {
    await requestJson(
      `${endpoints.apiBaseUrl}/v1/conversations/${encodeURIComponent(conversationId)}/end`,
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
 * The handshake headers of both WebSockets. React Native can set them, so the access token goes
 * here rather than into the URL.
 */
export function buildWebSocketHeaders(endpoints: RealtimeEndpoints, accessToken: string): Record<string, string> {
  return { Origin: endpoints.appOrigin, Authorization: `Bearer ${accessToken.trim()}` };
}
