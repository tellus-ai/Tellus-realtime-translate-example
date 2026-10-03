import type { DesktopError, StartConversationInput } from './shared/desktopApi';

const REQUEST_TIMEOUT_MS = 15_000;

export type FetchFunction = (url: string, init: RequestInit) => Promise<Response>;

export class RealtimeApiError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly messages: string[] = [message],
  ) {
    super(message);
    this.name = 'RealtimeApiError';
  }
}

export interface RealtimeApi {
  createConversation(): Promise<string>;
  saveInterpretationSettings(conversationId: string, input: StartConversationInput): Promise<void>;
  endConversation(conversationId: string): Promise<void>;
}

type ApiEnvelope<T> = {
  statusCode: string;
  message: string[];
  data: T;
};

interface ConversationResponse {
  conversation_id?: string;
}

export function createRealtimeApi(
  config: { httpBaseUrl: string; accessToken: string },
  fetchFunction: FetchFunction,
): RealtimeApi {
  const post = <T>(path: string, body?: unknown): Promise<T> => {
    if (!config.accessToken) {
      return Promise.reject(new RealtimeApiError('Set API_KEY in desktop/.env and restart the app.', null));
    }
    return requestJson<T>(fetchFunction, `${config.httpBaseUrl}${path}`, config.accessToken, {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  };

  return {
    async createConversation() {
      const response = await post<ConversationResponse | null>('/conversations', {
        max_concurrent_viewers: 10,
        conversation_audio_mode: 'single_speaker',
      });
      if (!response?.conversation_id) {
        throw new Error('Conversation response is missing conversation_id.');
      }
      return response.conversation_id;
    },

    async saveInterpretationSettings(conversationId, input) {
      await post(`/conversations/${encodeURIComponent(conversationId)}/interpretation-settings`, {
        languages: [input.sourceLanguage, input.targetLanguage],
        transcription: { client_vad: input.clientVad },
        translation: {},
      });
    },

    async endConversation(conversationId) {
      await post(`/conversations/${encodeURIComponent(conversationId)}/end`);
    },
  };
}

export function toDesktopError(error: unknown): DesktopError {
  if (error instanceof RealtimeApiError) {
    return { message: error.message, status: error.status, messages: error.messages };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { message, status: null, messages: [message] };
}

async function requestJson<T>(
  fetchFunction: FetchFunction,
  url: string,
  accessToken: string,
  init: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchFunction(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken}`,
        ...init.headers,
      },
    });
  } catch (error) {
    throw new RealtimeApiError(
      error instanceof Error ? error.message : 'Network request failed.',
      null,
    );
  }

  const raw = await response.text();
  let body: unknown = null;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = raw;
    }
  }

  if (!response.ok) {
    const messages = readMessages(body);
    const fallback = typeof body === 'string' && body ? body : `HTTP ${response.status}`;
    throw new RealtimeApiError(messages[0] ?? fallback, response.status, messages);
  }

  return unwrapEnvelope<T>(body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readMessages(value: unknown): string[] {
  if (!isRecord(value)) return [];
  if (Array.isArray(value.message)) {
    return value.message.filter((item): item is string => typeof item === 'string');
  }
  return typeof value.message === 'string' ? [value.message] : [];
}

function unwrapEnvelope<T>(value: unknown): T {
  if (isRecord(value) && 'data' in value && typeof value.statusCode === 'string') {
    return (value as ApiEnvelope<T>).data;
  }
  return value as T;
}
