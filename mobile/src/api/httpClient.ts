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
    return value.data as T;
  }
  return value as T;
}

/**
 * True when nobody answered: the request failed or timed out here (`null`), or this example's
 * server reports that Tellus could not be reached (`502`) or did not answer in time (`504`).
 * Tellus may still have applied such a request.
 */
export function gotNoResponse(status: number | null): boolean {
  return status === null || status === 502 || status === 504;
}

// REST error responses carry no Retry-After header, so temporary failures use fixed waits.
const RETRY_DELAYS_MS = [1_000, 2_000, 5_000];
const REQUEST_TIMEOUT_MS = 15_000;

export interface RequestOptions {
  /**
   * Also retry when no response arrives. Only for requests that are safe to repeat: a create
   * request may have succeeded on the server even though its response was lost.
   */
  retryNetworkFailure?: boolean;
}

/** Sends the request again after a 503, up to three more times. Other statuses are not retried. */
export async function requestJson<T>(url: string, init: RequestInit, { retryNetworkFailure = false }: RequestOptions = {}): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await requestOnce<T>(url, init);
    } catch (error) {
      const status = error instanceof RealtimeApiError ? error.status : undefined;
      // No response includes a request that ran into REQUEST_TIMEOUT_MS.
      const temporary = status === 503 || (status !== undefined && gotNoResponse(status) && retryNetworkFailure);
      if (!temporary || attempt >= RETRY_DELAYS_MS.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
  }
}

async function requestOnce<T>(url: string, init: RequestInit): Promise<T> {
  // React Native has no `AbortSignal.timeout`.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  let raw: string;
  try {
    response = await fetch(url, {
      ...init,
      signal: controller.signal,
      // No credential: these calls go to this example's own server, which holds the API key
      // (scripts/conversation-api-middleware.cjs). The header shows that this app sent them.
      headers: {
        'Content-Type': 'application/json',
        'X-Tellus-Example-Api': '1',
        ...init.headers,
      },
    });
    raw = await response.text();
  } catch (error) {
    throw new RealtimeApiError(
      controller.signal.aborted ? 'The request timed out.' : error instanceof Error ? error.message : 'Network request failed.',
      null,
    );
  } finally {
    clearTimeout(timeout);
  }
  let body: unknown = null;
  if (raw) {
    try { body = JSON.parse(raw); } catch { body = raw; }
  }
  if (!response.ok) {
    const messages = readMessages(body);
    const fallback = typeof body === 'string' && body ? body : `HTTP ${response.status}`;
    throw new RealtimeApiError(messages[0] ?? fallback, response.status, messages);
  }
  return unwrapEnvelope<T>(body);
}
