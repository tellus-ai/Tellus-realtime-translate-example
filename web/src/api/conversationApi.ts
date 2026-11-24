import { RealtimeApiError, requestJson } from './httpClient';
import type { RealtimeAudioFormat } from '../audio/RealtimeAudioFormat';

export interface RealtimeEndpoints {
  audioSdkEnabled?: boolean;
  /**
   * This example's own server routes. They forward the calls below to Tellus with the API key,
   * so that the key is never in the browser.
   */
  apiBaseUrl: string;
  /** Tellus itself. The browser opens the WebSockets directly, with an access token. */
  websocketBaseUrl: string;
}

export interface StartConversationInput {
  sourceLanguage: string;
  targetLanguage: string;
  clientVad: boolean;
}

interface ConversationResponse {
  conversation_id: string;
}

interface AccessTokenResponse {
  access_token: string;
  expires_at_ms: number;
}

export interface IssuedAccessToken {
  token: string;
  /** Epoch milliseconds. A token lasts 15 minutes. */
  expiresAtMs: number;
}

export async function createConversation(endpoints: RealtimeEndpoints): Promise<string> {
  // No body: the settings are saved by the next call.
  const response = await requestJson<ConversationResponse>(
    `${endpoints.apiBaseUrl}/v1/conversations`,
    { method: 'POST' },
  );
  if (!response.conversation_id) {
    throw new Error('Conversation response is missing conversation_id.');
  }
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
    {
      method: 'POST',
      body: JSON.stringify({
        languages: [sourceLanguage, targetLanguage],
        transcription: { client_vad: clientVad },
      }),
    },
  );
}

/**
 * Asks this example's server for an access token that opens the WebSockets of one Conversation.
 * The token is the only credential the browser ever holds.
 */
export async function issueAccessToken(
  endpoints: RealtimeEndpoints,
  conversationId: string,
): Promise<IssuedAccessToken> {
  const response = await requestJson<AccessTokenResponse>(
    `${endpoints.apiBaseUrl}/v1/access-tokens`,
    {
      method: 'POST',
      body: JSON.stringify({ session_kind: 'conversation', session_id: conversationId }),
    },
    // Issuing again is harmless: a token is not stored on the server.
    { retryNetworkFailure: true },
  );
  if (!response.access_token || !Number.isFinite(response.expires_at_ms)) {
    throw new Error('Access token response is missing access_token or expires_at_ms.');
  }
  return { token: response.access_token, expiresAtMs: response.expires_at_ms };
}

/** Resolves once the Conversation is over, whether or not this call was the one that ended it. */
export async function endConversation(
  endpoints: RealtimeEndpoints,
  conversationId: string,
): Promise<void> {
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
export function buildResultWebSocketUrl(
  endpoints: RealtimeEndpoints,
  conversationId: string,
  accessToken: string,
  afterOrderSeq: number | null = null,
): string {
  const query = new URLSearchParams({ token: accessToken });
  if (afterOrderSeq !== null) query.set('after_order_seq', String(afterOrderSeq));
  return `${endpoints.websocketBaseUrl}/v1/conversations/${encodeURIComponent(conversationId)}/results?${query}`;
}

export function buildAudioWebSocketUrl(
  endpoints: RealtimeEndpoints,
  conversationId: string,
  audioFormat: RealtimeAudioFormat,
  accessToken: string,
): string {
  const query = new URLSearchParams({
    conversation_id: conversationId,
    audio_format: audioFormat,
    token: accessToken,
  });
  return `${endpoints.websocketBaseUrl}/v1/audio?${query}`;
}
