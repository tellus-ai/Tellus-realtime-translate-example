import type { DesktopError, StartConversationInput } from './shared/desktopApi';

const REQUEST_TIMEOUT_MS = 15_000;
// REST error responses carry no Retry-After header, so temporary failures use fixed waits.
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000];

export type FetchFunction = (url: string, init: RequestInit) => Promise<Response>;

export class RealtimeApiError extends Error {
  constructor(
    message: string,
    /** The HTTP status, or null when no response arrived. */
    readonly status: number | null,
    readonly messages: string[] = [message],
  ) {
    super(message);
    this.name = 'RealtimeApiError';
  }
}

/**
 * True when nobody answered: the request failed or timed out here (`null`), or the example server
 * reports that Tellus could not be reached (`502`) or did not answer in time (`504`). Tellus may
 * still have applied such a request.
 */
export function gotNoResponse(status: number | null): boolean {
  return status === null || status === 502 || status === 504;
}

export interface IssuedAccessToken {
  token: string;
  /** Epoch milliseconds. A token lasts 15 minutes. */
  expiresAtMs: number;
}

export interface RealtimeApi {
  createConversation(): Promise<string>;
  saveInterpretationSettings(conversationId: string, input: StartConversationInput): Promise<void>;
  /** An access token that opens the WebSockets of one Conversation, the only credential the app holds. */
  issueAccessToken(conversationId: string): Promise<IssuedAccessToken>;
  /** Resolves once the Conversation is over, whether or not this call was the one that ended it. */
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

interface AccessTokenResponse {
  access_token?: unknown;
  expires_at_ms?: unknown;
}

interface RequestOptions {
  /**
   * Also retry when no response arrives. Only for requests that are safe to repeat: a create
   * request may have succeeded on the server even though its response was lost.
   */
  retryNetworkFailure?: boolean;
}

/**
 * `apiBaseUrl` is the example's own server (scripts/conversation-api-middleware.cjs under
 * `npm run dev`, or `TELLUS_EXAMPLE_API_URL`). It forwards these calls to Tellus with the API key,
 * so the key is never in this app. Null when no such server is configured.
 */
export function createRealtimeApi(
  config: { apiBaseUrl: string | null },
  fetchFunction: FetchFunction,
): RealtimeApi {
  const post = <T>(path: string, body?: unknown, options?: RequestOptions): Promise<T> => {
    if (!config.apiBaseUrl) {
      // A plain Error: this is a configuration problem, not a request that got no response.
      return Promise.reject(new Error(
        'No example API server is configured. Run npm run dev, or set TELLUS_EXAMPLE_API_URL to the server that holds the API key.',
      ));
    }
    return requestJson<T>(fetchFunction, `${config.apiBaseUrl}${path}`, {
      method: 'POST',
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }, options);
  };

  return {
    async createConversation() {
      // No body: the settings are saved by the next call.
      const response = await post<ConversationResponse | null>('/v1/conversations');
      if (!response?.conversation_id) {
        throw new Error('Conversation response is missing conversation_id.');
      }
      return response.conversation_id;
    },

    async saveInterpretationSettings(conversationId, input) {
      await post(`/v1/conversations/${encodeURIComponent(conversationId)}/settings`, {
        languages: [input.sourceLanguage, input.targetLanguage],
        transcription: { client_vad: input.clientVad },
      });
    },

    async issueAccessToken(conversationId) {
      const response = await post<AccessTokenResponse | null>(
        '/v1/access-tokens',
        { session_kind: 'conversation', session_id: conversationId },
        // Issuing again is harmless: a token is not stored on the server.
        { retryNetworkFailure: true },
      );
      const token = response?.access_token;
      const expiresAtMs = response?.expires_at_ms;
      if (typeof token !== 'string' || !token || typeof expiresAtMs !== 'number' || !Number.isFinite(expiresAtMs)) {
        throw new Error('Access token response is missing access_token or expires_at_ms.');
      }
      return { token, expiresAtMs };
    },

    async endConversation(conversationId) {
      try {
        await post(`/v1/conversations/${encodeURIComponent(conversationId)}/end`, undefined, {
          retryNetworkFailure: true,
        });
      } catch (error) {
        // 410: already ended. 404: gone or expired, so it can no longer be ended.
        if (error instanceof RealtimeApiError && (error.status === 410 || error.status === 404)) return;
        throw error;
      }
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

/** Sends the request again after a 503, up to three more times. Other statuses are not retried. */
async function requestJson<T>(
  fetchFunction: FetchFunction,
  url: string,
  init: RequestInit,
  { retryNetworkFailure = false }: RequestOptions = {},
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await requestOnce<T>(fetchFunction, url, init);
    } catch (error) {
      const status = error instanceof RealtimeApiError ? error.status : undefined;
      // No response includes a request that ran into REQUEST_TIMEOUT_MS.
      const temporary = status === 503 ||
        (status !== undefined && gotNoResponse(status) && retryNetworkFailure);
      if (!temporary || attempt >= RETRY_DELAYS_MS.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
  }
}

async function requestOnce<T>(
  fetchFunction: FetchFunction,
  url: string,
  init: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetchFunction(url, {
      ...init,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      // No credential: the example server adds the API key. The header shows that this app sent
      // the request.
      headers: {
        'Content-Type': 'application/json',
        'X-Tellus-Example-Api': '1',
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
  if (typeof value.message === 'string') return [value.message];
  // `POST /v1/access-tokens` reports an error as `{"detail": "<text>"}`.
  return typeof value.detail === 'string' ? [value.detail] : [];
}

function unwrapEnvelope<T>(value: unknown): T {
  if (isRecord(value) && 'data' in value && typeof value.statusCode === 'string') {
    return (value as ApiEnvelope<T>).data;
  }
  return value as T;
}
