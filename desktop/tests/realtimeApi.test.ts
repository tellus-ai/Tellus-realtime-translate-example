import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeApiError, createRealtimeApi, toDesktopError } from '../electron/realtimeApi';

// The example's own server routes. They add the API key; the app never holds it.
const config = { apiBaseUrl: 'http://127.0.0.1:5173/__tellus/api' };
const EXAMPLE_HEADERS = { 'Content-Type': 'application/json', 'X-Tellus-Example-Api': '1' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('createRealtimeApi', () => {
  it('creates a conversation through the example server, without a credential or a request body, and unwraps the envelope', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      statusCode: '201',
      message: ['ok'],
      data: { conversation_id: 'conversation-1' },
    }, 201));
    const api = createRealtimeApi(config, fetchMock);

    await expect(api.createConversation()).resolves.toBe('conversation-1');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:5173/__tellus/api/v1/conversations');
    expect(init.method).toBe('POST');
    // The example server adds the API key. The header only shows that this app sent the request.
    expect(init.headers).toEqual(EXAMPLE_HEADERS);
    // The settings are saved by the next call.
    expect(init.body).toBeUndefined();
  });

  it('saves the two languages and the client VAD flag as settings', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ statusCode: '200', message: ['ok'], data: {} }));
    const api = createRealtimeApi(config, fetchMock);

    await api.saveInterpretationSettings('a/b', { sourceLanguage: 'ko-KR', targetLanguage: 'en-US', clientVad: true });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:5173/__tellus/api/v1/conversations/a%2Fb/settings');
    expect(JSON.parse(String(init.body))).toEqual({
      languages: ['ko-KR', 'en-US'],
      transcription: { client_vad: true },
    });
  });

  it('ends a conversation without a request body', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ statusCode: '200', message: ['ok'], data: { ended: true } }));
    const api = createRealtimeApi(config, fetchMock);

    await api.endConversation('conversation-1');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:5173/__tellus/api/v1/conversations/conversation-1/end');
    expect(init.body).toBeUndefined();
  });

  it('surfaces the server message and status of a failed request', async () => {
    const api = createRealtimeApi(config, async () => jsonResponse({ statusCode: '401', message: ['Invalid token'] }, 401));

    const error = await api.createConversation().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RealtimeApiError);
    expect(toDesktopError(error)).toEqual({ message: 'Invalid token', status: 401, messages: ['Invalid token'] });
  });

  it('asks for an access token of one Conversation and reads the response, which has no envelope', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ access_token: 'tl_at_1', expires_at_ms: 1_000 }, 201));
    const api = createRealtimeApi(config, fetchMock);

    await expect(api.issueAccessToken('conversation-1')).resolves.toEqual({ token: 'tl_at_1', expiresAtMs: 1_000 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('http://127.0.0.1:5173/__tellus/api/v1/access-tokens');
    expect(init.headers).toEqual(EXAMPLE_HEADERS);
    expect(JSON.parse(String(init.body))).toEqual({ session_kind: 'conversation', session_id: 'conversation-1' });
  });

  it('reports the detail of an access token error and rejects a response without a token', async () => {
    const refused = createRealtimeApi(config, async () => jsonResponse({ detail: 'Session has already ended' }, 410));
    await expect(refused.issueAccessToken('c1')).rejects.toMatchObject({ message: 'Session has already ended', status: 410 });

    const empty = createRealtimeApi(config, async () => jsonResponse({}, 201));
    await expect(empty.issueAccessToken('c1')).rejects.toThrow('Access token response is missing access_token or expires_at_ms.');
  });

  it('rejects without a request when no example API server is configured', async () => {
    const fetchMock = vi.fn();
    const api = createRealtimeApi({ apiBaseUrl: null }, fetchMock);

    for (const call of [api.createConversation(), api.issueAccessToken('c1'), api.endConversation('c1')]) {
      await expect(call).rejects.toThrow('TELLUS_EXAMPLE_API_URL');
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a create response without conversation_id', async () => {
    const api = createRealtimeApi(config, async () => jsonResponse({ statusCode: '201', message: ['ok'], data: {} }, 201));

    await expect(api.createConversation()).rejects.toThrow('missing conversation_id');
  });
});

describe('createRealtimeApi retries', () => {
  const NETWORK_FAILURE = 'network failure';
  type Reply = { status: number; body?: unknown } | typeof NETWORK_FAILURE;
  let replies: Reply[];
  let requests: string[];

  const api = createRealtimeApi(config, async (url, init) => {
    requests.push(`${init.method} ${url.replace(config.apiBaseUrl, '')}`);
    const reply = replies.shift() ?? { status: 200, body: {} };
    if (reply === NETWORK_FAILURE) throw new TypeError('Failed to fetch');
    return jsonResponse(reply.body ?? {}, reply.status);
  });

  beforeEach(() => {
    vi.useFakeTimers();
    replies = [];
    requests = [];
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Runs the retry waits and returns how the call settled. */
  async function settle<T>(call: Promise<T>): Promise<{ value?: T; error?: Error }> {
    const outcome = call.then(
      (value) => ({ value }),
      (error: Error) => ({ error }),
    );
    await vi.runAllTimersAsync();
    return outcome;
  }

  describe('endConversation', () => {
    it.each([200, 410, 404])('treats %i as ended', async (status) => {
      replies = [{ status, body: { message: ['Conversation has already ended.'] } }];
      expect(await settle(api.endConversation('c1'))).toEqual({ value: undefined });
      expect(requests).toEqual(['POST /v1/conversations/c1/end']);
    });

    it('calls again after 503 and after a network failure, waiting 1, 2, and 5 seconds', async () => {
      replies = [{ status: 503 }, NETWORK_FAILURE, { status: 503 }, { status: 200 }];
      const call = api.endConversation('c1');
      for (const [waitMs, sent] of [[0, 1], [999, 1], [1, 2], [2_000, 3], [4_999, 3], [1, 4]]) {
        await vi.advanceTimersByTimeAsync(waitMs);
        expect(requests).toHaveLength(sent);
      }
      await expect(call).resolves.toBeUndefined();
    });

    it('gives up after three retries and reports the server message', async () => {
      const unavailable = { status: 503, body: { message: ['Temporarily unavailable.'] } };
      replies = [unavailable, unavailable, unavailable, unavailable, unavailable];
      const { error } = await settle(api.endConversation('c1'));
      expect(requests).toHaveLength(4);
      expect(error?.message).toBe('Temporarily unavailable.');
    });

    // The example server answers 502 or 504 when Tellus could not be reached or was too slow.
    it.each([502, 504])('calls again after %i from the example server, as after no response', async (status) => {
      replies = [{ status, body: { message: ['The speech server did not answer in time.'] } }, { status: 200 }];
      expect(await settle(api.endConversation('c1'))).toEqual({ value: undefined });
      expect(requests).toHaveLength(2);
    });

    it.each([401, 403])('does not retry %i', async (status) => {
      replies = [{ status, body: { message: ['Permission denied.'] } }];
      const { error } = await settle(api.endConversation('c1'));
      expect(requests).toHaveLength(1);
      expect(error?.message).toBe('Permission denied.');
    });
  });

  describe('createConversation and saveInterpretationSettings', () => {
    const saveSettings = () =>
      api.saveInterpretationSettings('c1', { sourceLanguage: 'ko-KR', targetLanguage: 'en-US', clientVad: true });

    it('retry 503', async () => {
      const created = { status: 200, body: { conversation_id: 'c1' } };
      replies = [{ status: 503 }, created, { status: 503 }, { status: 200 }];
      expect(await settle(api.createConversation())).toEqual({ value: 'c1' });
      expect(await settle(saveSettings())).toEqual({ value: undefined });
      expect(requests).toHaveLength(4);
    });

    // The Conversation may exist even though its response was lost; a second create would
    // leave one that nobody ends.
    it('do not retry a network failure', async () => {
      replies = [NETWORK_FAILURE, NETWORK_FAILURE];
      expect((await settle(api.createConversation())).error?.message).toBe('Failed to fetch');
      expect((await settle(saveSettings())).error?.message).toBe('Failed to fetch');
      expect(requests).toHaveLength(2);
    });

    // Tellus may have created the Conversation although the example server saw no answer.
    it.each([502, 504])('do not retry %i from the example server', async (status) => {
      const unanswered = { status, body: { message: ['The speech server could not be reached.'] } };
      replies = [unanswered, unanswered];
      expect((await settle(api.createConversation())).error?.message).toBe('The speech server could not be reached.');
      expect((await settle(saveSettings())).error?.message).toBe('The speech server could not be reached.');
      expect(requests).toHaveLength(2);
    });
  });

  describe('issueAccessToken', () => {
    // Issuing again is harmless: a token is not stored on the server.
    it.each([
      ['a network failure', NETWORK_FAILURE],
      ['504 from the example server', { status: 504 }],
    ] as const)('calls again after %s', async (_name, failure) => {
      replies = [failure, { status: 201, body: { access_token: 'tl_at_1', expires_at_ms: 1_000 } }];
      expect((await settle(api.issueAccessToken('c1'))).value?.token).toBe('tl_at_1');
      expect(requests).toEqual(['POST /v1/access-tokens', 'POST /v1/access-tokens']);
    });
  });
});
