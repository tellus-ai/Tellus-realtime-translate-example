import { RealtimeApiError, requestJson } from './httpClient';

export interface RealtimeEndpoints {
  httpBaseUrl: string;
  websocketBaseUrl: string;
  appOrigin: string;
}

export interface StartConversationInput {
  sourceLanguage: string;
  targetLanguage: string;
  clientVad: boolean;
}

export async function createConversation(endpoints: RealtimeEndpoints, accessToken: string): Promise<string> {
  const response = await requestJson<{ conversation_id: string }>(
    `${endpoints.httpBaseUrl}/conversations`, accessToken,
    { method: 'POST', body: JSON.stringify({ max_concurrent_viewers: 10, conversation_audio_mode: 'single_speaker' }) },
  );
  if (!response.conversation_id) throw new Error('Conversation response is missing conversation_id.');
  return response.conversation_id;
}

export async function saveInterpretationSettings(
  endpoints: RealtimeEndpoints,
  accessToken: string,
  conversationId: string,
  sourceLanguage: string,
  targetLanguage: string,
  clientVad: boolean,
): Promise<void> {
  await requestJson(
    `${endpoints.httpBaseUrl}/conversations/${encodeURIComponent(conversationId)}/interpretation-settings`,
    accessToken,
    { method: 'POST', body: JSON.stringify({ languages: [sourceLanguage, targetLanguage], transcription: { client_vad: clientVad }, translation: {} }) },
  );
}

/** Resolves once the Conversation is over, whether or not this call was the one that ended it. */
export async function endConversation(
  endpoints: RealtimeEndpoints,
  accessToken: string,
  conversationId: string,
): Promise<void> {
  try {
    await requestJson(
      `${endpoints.httpBaseUrl}/conversations/${encodeURIComponent(conversationId)}/end`,
      accessToken,
      { method: 'POST' },
      { retryNetworkFailure: true },
    );
  } catch (error) {
    // 410: already ended. 404: gone or expired, so it can no longer be ended.
    if (error instanceof RealtimeApiError && (error.status === 410 || error.status === 404)) return;
    throw error;
  }
}

export function buildResultWebSocketUrl(endpoints: RealtimeEndpoints, conversationId: string): string {
  return `${endpoints.websocketBaseUrl}/conversations/${encodeURIComponent(conversationId)}/results`;
}

export function buildAudioWebSocketUrl(endpoints: RealtimeEndpoints, conversationId: string): string {
  return `${endpoints.websocketBaseUrl}/audio?conversation_id=${encodeURIComponent(conversationId)}&audio_format=opus`;
}
