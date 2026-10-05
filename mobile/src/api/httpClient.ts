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
  return typeof value.message === 'string' ? [value.message] : [];
}

function unwrapEnvelope<T>(value: unknown): T {
  if (isRecord(value) && 'data' in value && typeof value.statusCode === 'string') {
    return value.data as T;
  }
  return value as T;
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
export async function requestJson<T>(url: string, accessToken: string, init: RequestInit, { retryNetworkFailure = false }: RequestOptions = {}): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await requestOnce<T>(url, accessToken, init);
    } catch (error) {
      const status = error instanceof RealtimeApiError ? error.status : undefined;
      // No response includes a request that ran into REQUEST_TIMEOUT_MS.
      const temporary = status === 503 || (status === null && retryNetworkFailure);
      if (!temporary || attempt >= RETRY_DELAYS_MS.length) throw error;
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAYS_MS[attempt]));
    }
  }
}

async function requestOnce<T>(url: string, accessToken: string, init: RequestInit): Promise<T> {
  // React Native has no `AbortSignal.timeout`.
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let response: Response;
  let raw: string;
  try {
    response = await fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken.trim()}`,
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
