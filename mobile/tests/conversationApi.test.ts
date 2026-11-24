import { ConversationAccessTokens } from '../src/api/accessTokens';
import {
  createConversation,
  buildAudioWebSocketUrl,
  buildResultWebSocketUrl,
  buildWebSocketHeaders,
  endConversation,
  issueAccessToken,
  saveInterpretationSettings,
} from '../src/api/conversationApi';

const endpoints = { apiBaseUrl: 'https://example.test', websocketBaseUrl: 'wss://example.test', appOrigin: 'https://app.example.test' };
// This app's own server holds the API key and adds it. The app sends only this header.
const EXAMPLE_HEADERS = { 'Content-Type': 'application/json', 'X-Tellus-Example-Api': '1' };
const NETWORK_FAILURE = 'network failure';
const NO_ANSWER = 'no answer';

type Reply = { status: number; body?: unknown } | typeof NETWORK_FAILURE | typeof NO_ANSWER;

describe('conversation API', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('saves the two languages and client VAD through the /v1 settings route', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ statusCode: '200', message: ['ok'], data: {} }),
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await saveInterpretationSettings(
      endpoints,
      'conversation-1',
      'ko-KR',
      'en-US',
      true,
    );

    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.test/v1/conversations/conversation-1/settings');
    expect(JSON.parse(String(request.body))).toEqual({
      languages: ['ko-KR', 'en-US'],
      transcription: { client_vad: true },
    });
    // No credential: the example server adds the API key.
    expect(request.headers).toEqual(EXAMPLE_HEADERS);
  });

  it('creates a Conversation through the /v1 route without a body', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ statusCode: '201', message: ['ok'], data: { conversation_id: 'c1' } }),
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(createConversation(endpoints)).resolves.toBe('c1');
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.test/v1/conversations');
    expect(request.method).toBe('POST');
    expect(request.body).toBeUndefined();
    expect(request.headers).toEqual(EXAMPLE_HEADERS);
  });

  it('asks the example server for an access token of one Conversation; the answer has no envelope', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ access_token: 'tl_at_1', expires_at_ms: 1_000 }),
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await expect(issueAccessToken(endpoints, 'c1')).resolves.toEqual({ token: 'tl_at_1', expiresAtMs: 1_000 });
    const [url, request] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.test/v1/access-tokens');
    expect(JSON.parse(String(request.body))).toEqual({ session_kind: 'conversation', session_id: 'c1' });
    expect(request.headers).toEqual(EXAMPLE_HEADERS);
  });

  it('reports the detail of an access token error and rejects an answer without a token', async () => {
    globalThis.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: false, status: 410, text: async () => JSON.stringify({ detail: 'Session has already ended' }) })
      .mockResolvedValueOnce({ ok: true, status: 201, text: async () => '{}' }) as unknown as typeof fetch;
    await expect(issueAccessToken(endpoints, 'c1')).rejects.toMatchObject({ message: 'Session has already ended', status: 410 });
    await expect(issueAccessToken(endpoints, 'c1')).rejects.toThrow('Access token response is missing access_token or expires_at_ms.');
  });
});

describe('WebSocket handshake', () => {
  it('opens the /v1 routes and keeps every credential out of the URL', () => {
    expect(buildResultWebSocketUrl(endpoints, 'a/b')).toBe('wss://example.test/v1/conversations/a%2Fb/results');
    expect(buildAudioWebSocketUrl(endpoints, 'a/b')).toBe(
      'wss://example.test/v1/audio?conversation_id=a%2Fb&audio_format=opus',
    );
  });

  it('adds after_order_seq to Result, including 0', () => {
    expect(buildResultWebSocketUrl(endpoints, 'c1', 0)).toBe(
      'wss://example.test/v1/conversations/c1/results?after_order_seq=0',
    );
    expect(buildResultWebSocketUrl(endpoints, 'c1', 12)).toBe(
      'wss://example.test/v1/conversations/c1/results?after_order_seq=12',
    );
  });

  it('sends the access token in the Authorization header, next to the allowed Origin', () => {
    expect(buildWebSocketHeaders(endpoints, ' tl_at_1 ')).toEqual({
      Origin: 'https://app.example.test',
      Authorization: 'Bearer tl_at_1',
    });
  });
});

describe('conversation API retries', () => {
  const originalFetch = globalThis.fetch;
  let replies: Reply[];
  let requests: string[];

  beforeEach(() => {
    jest.useFakeTimers();
    replies = [];
    requests = [];
    globalThis.fetch = jest.fn(async (url: string, init: RequestInit) => {
      requests.push(`${init.method} ${url.replace(endpoints.apiBaseUrl, '')}`);
      const reply = replies.shift() ?? { status: 200, body: {} };
      if (reply === NETWORK_FAILURE) throw new TypeError('Network request failed');
      // Like fetch, a request that is never answered ends only when its signal aborts it.
      if (reply === NO_ANSWER) return new Promise((_resolve, reject) => init.signal?.addEventListener('abort', () => reject(new Error('Aborted'))));
      const body = JSON.stringify(reply.body ?? {});
      return { ok: reply.status < 300, status: reply.status, text: async () => body };
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    jest.useRealTimers();
    globalThis.fetch = originalFetch;
  });

  /** Runs the retry waits and returns how the call settled. */
  async function settle<T>(call: Promise<T>): Promise<{ value?: T; error?: Error }> {
    const outcome = call.then((value) => ({ value }), (error: Error) => ({ error }));
    await jest.runAllTimersAsync();
    return outcome;
  }

  describe('endConversation', () => {
    it.each([200, 410, 404])('treats %i as ended', async (status) => {
      replies = [{ status, body: { message: ['Conversation has already ended.'] } }];
      expect(await settle(endConversation(endpoints, 'c1'))).toEqual({ value: undefined });
      expect(requests).toEqual(['POST /v1/conversations/c1/end']);
    });

    it('calls again after 503 and after a network failure, waiting 1, 2, and 5 seconds', async () => {
      replies = [{ status: 503 }, NETWORK_FAILURE, { status: 503 }, { status: 200 }];
      const call = endConversation(endpoints, 'c1');
      for (const [waitMs, sent] of [[0, 1], [999, 1], [1, 2], [2_000, 3], [4_999, 3], [1, 4]]) {
        await jest.advanceTimersByTimeAsync(waitMs);
        expect(requests).toHaveLength(sent);
      }
      await expect(call).resolves.toBeUndefined();
    });

    it('gives up after three retries and reports the server message', async () => {
      const unavailable = { status: 503, body: { message: ['Temporarily unavailable.'] } };
      replies = [unavailable, unavailable, unavailable, unavailable, unavailable];
      const { error } = await settle(endConversation(endpoints, 'c1'));
      expect(requests).toHaveLength(4);
      expect(error?.message).toBe('Temporarily unavailable.');
    });

    it('calls again when a request got no answer within 15 seconds', async () => {
      replies = [NO_ANSWER, { status: 200 }];
      const call = endConversation(endpoints, 'c1');
      for (const [waitMs, sent] of [[0, 1], [14_999, 1], [1, 1], [999, 1], [1, 2]]) {
        await jest.advanceTimersByTimeAsync(waitMs);
        expect(requests).toHaveLength(sent);
      }
      await expect(call).resolves.toBeUndefined();
      // The timeout of a request that was answered is cancelled.
      expect(jest.getTimerCount()).toBe(0);
    });

    // The example server answers 502 or 504 when Tellus could not be reached or was too slow.
    it.each([502, 504])('calls again after %i from the example server, as after no response', async (status) => {
      replies = [{ status, body: { message: ['The speech server did not answer in time.'] } }, { status: 200 }];
      expect(await settle(endConversation(endpoints, 'c1'))).toEqual({ value: undefined });
      expect(requests).toHaveLength(2);
    });

    it.each([401, 403])('does not retry %i', async (status) => {
      replies = [{ status, body: { message: ['Permission denied.'] } }];
      const { error } = await settle(endConversation(endpoints, 'c1'));
      expect(requests).toHaveLength(1);
      expect(error?.message).toBe('Permission denied.');
    });
  });

  describe('createConversation and saveInterpretationSettings', () => {
    const saveSettings = () => saveInterpretationSettings(endpoints, 'c1', 'ko-KR', 'en-US', true);

    it('retry 503', async () => {
      const created = { status: 200, body: { conversation_id: 'c1' } };
      replies = [{ status: 503 }, created, { status: 503 }, { status: 200 }];
      expect(await settle(createConversation(endpoints))).toEqual({ value: 'c1' });
      expect(await settle(saveSettings())).toEqual({ value: undefined });
      expect(requests).toEqual([
        'POST /v1/conversations', 'POST /v1/conversations',
        'POST /v1/conversations/c1/settings', 'POST /v1/conversations/c1/settings',
      ]);
    });

    // The Conversation may exist even though its response was lost; a second create would
    // leave one that nobody ends.
    it('do not retry a network failure', async () => {
      replies = [NETWORK_FAILURE, NETWORK_FAILURE];
      expect((await settle(createConversation(endpoints))).error?.message).toBe('Network request failed');
      expect((await settle(saveSettings())).error?.message).toBe('Network request failed');
      expect(requests).toHaveLength(2);
    });

    // Tellus may have created the Conversation although the example server saw no answer.
    it.each([502, 504])('do not retry %i from the example server', async (status) => {
      const unanswered = { status, body: { message: ['The speech server could not be reached.'] } };
      replies = [unanswered, unanswered];
      expect((await settle(createConversation(endpoints))).error?.message).toBe('The speech server could not be reached.');
      expect((await settle(saveSettings())).error?.message).toBe('The speech server could not be reached.');
      expect(requests).toHaveLength(2);
    });

    it('fail after 15 seconds without an answer, and do not retry', async () => {
      replies = [NO_ANSWER, NO_ANSWER];
      const created = createConversation(endpoints).catch((error: Error) => error.message);
      await jest.advanceTimersByTimeAsync(14_999);
      expect(jest.getTimerCount()).toBe(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(await created).toBe('The request timed out.');
      expect((await settle(saveSettings())).error?.message).toBe('The request timed out.');
      expect(requests).toHaveLength(2);
    });
  });

  describe('issueAccessToken', () => {
    // Unlike a create request, issuing a token twice leaves nothing behind.
    it.each([
      ['a network failure', NETWORK_FAILURE],
      ['504 from the example server', { status: 504, body: { message: ['The speech server did not answer in time.'] } }],
    ] as const)('calls again after %s', async (_name, failure) => {
      replies = [failure, { status: 201, body: { access_token: 'tl_at_1', expires_at_ms: 1_000 } }];
      expect((await settle(issueAccessToken(endpoints, 'c1'))).value?.token).toBe('tl_at_1');
      expect(requests).toEqual(['POST /v1/access-tokens', 'POST /v1/access-tokens']);
    });
  });

  describe('ConversationAccessTokens', () => {
    const LIFETIME_MS = 15 * 60_000;
    const next = (token: string) => ({ status: 201, body: { access_token: token, expires_at_ms: Date.now() + LIFETIME_MS } });

    it('reuses a token until one minute before it expires, then issues the next', async () => {
      const tokens = new ConversationAccessTokens(endpoints, 'c1');
      replies = [next('first')];
      await expect(tokens.get()).resolves.toBe('first');
      await jest.advanceTimersByTimeAsync(LIFETIME_MS - 60_001);
      await expect(tokens.get()).resolves.toBe('first');
      expect(requests).toHaveLength(1);

      await jest.advanceTimersByTimeAsync(1);
      replies = [next('second')];
      await expect(tokens.get()).resolves.toBe('second');
      expect(requests).toHaveLength(2);
    });

    it('shares one request between callers that ask at the same time', async () => {
      const tokens = new ConversationAccessTokens(endpoints, 'c1');
      replies = [next('first')];
      await expect(Promise.all([tokens.get(), tokens.get()])).resolves.toEqual(['first', 'first']);
      expect(requests).toHaveLength(1);
    });

    it('asks again after a failed request instead of keeping the failure', async () => {
      const tokens = new ConversationAccessTokens(endpoints, 'c1');
      replies = [{ status: 401, body: { detail: 'Invalid API key' } }, next('first')];
      await expect(tokens.get()).rejects.toThrow('Invalid API key');
      await expect(tokens.get()).resolves.toBe('first');
    });
  });
});

// 전송한 Opus payload와 URL의 server decoder가 일치해야 한다.
test('SDK Opus 전송 형식을 선언한다', () => {
  const url = new URL(buildAudioWebSocketUrl(endpoints, 'id with space'));
  expect(url.searchParams.get('audio_format')).toBe('opus');
  expect(url.searchParams.get('conversation_id')).toBe('id with space');
});
