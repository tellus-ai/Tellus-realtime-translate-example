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

type ApiEnvelope<T> = {
  statusCode: string;
  message: string[];
  data: T;
};

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

export async function requestJson<T>(
  url: string,
  accessToken: string,
  init: RequestInit,
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${accessToken.trim()}`,
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
