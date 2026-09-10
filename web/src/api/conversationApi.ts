import { requestJson } from './httpClient';
import type { RealtimeAudioFormat } from '../audio/RealtimeAudioFormat';

export interface RealtimeEndpoints {
  httpBaseUrl: string;
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

export async function createConversation(
  endpoints: RealtimeEndpoints,
  accessToken: string,
): Promise<string> {
  const response = await requestJson<ConversationResponse>(
    `${endpoints.httpBaseUrl}/conversations`,
    accessToken,
    {
      method: 'POST',
      body: JSON.stringify({
        max_concurrent_viewers: 10,
        conversation_audio_mode: 'single_speaker',
      }),
    },
  );
  if (!response.conversation_id) {
    throw new Error('Conversation response is missing conversation_id.');
  }
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
    {
      method: 'POST',
      body: JSON.stringify({
        languages: [sourceLanguage, targetLanguage],
        transcription: { client_vad: clientVad },
        translation: {},
      }),
    },
  );
}

export async function endConversation(
  endpoints: RealtimeEndpoints,
  accessToken: string,
  conversationId: string,
): Promise<void> {
  await requestJson(
    `${endpoints.httpBaseUrl}/conversations/${encodeURIComponent(conversationId)}/end`,
    accessToken,
    { method: 'POST' },
  );
}

export function buildResultWebSocketUrl(
  endpoints: RealtimeEndpoints,
  conversationId: string,
): string {
  return `${endpoints.websocketBaseUrl}/conversations/${encodeURIComponent(conversationId)}/results`;
}

export function buildAudioWebSocketUrl(
  endpoints: RealtimeEndpoints,
  conversationId: string,
  audioFormat: RealtimeAudioFormat,
): string {
  const id = encodeURIComponent(conversationId);
  return `${endpoints.websocketBaseUrl}/audio?conversation_id=${id}&audio_format=${audioFormat}`;
}
