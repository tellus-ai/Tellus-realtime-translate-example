import {
  createConversation,
  endConversation,
  saveInterpretationSettings,
} from '../src/api/conversationApi';

const endpoints = { httpBaseUrl: 'https://example.test', websocketBaseUrl: 'wss://example.test', appOrigin: 'https://app.example.test' };
const NETWORK_FAILURE = 'network failure';
const NO_ANSWER = 'no answer';

type Reply = { status: number; body?: unknown } | typeof NETWORK_FAILURE | typeof NO_ANSWER;

describe('conversation API', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('includes translation settings when two languages are configured', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: async () => JSON.stringify({ statusCode: '200', message: ['ok'], data: {} }),
    });
    globalThis.fetch = fetchMock as typeof fetch;

    await saveInterpretationSettings(
      {
        httpBaseUrl: 'https://example.test',
        websocketBaseUrl: 'wss://example.test',
        appOrigin: 'https://app.example.test',
      },
      'token',
      'conversation-1',
      'ko-KR',
      'en-US',
      true,
    );

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(JSON.parse(String(request.body))).toEqual({
      languages: ['ko-KR', 'en-US'],
      transcription: { client_vad: true },
      translation: {},
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
      requests.push(`${init.method} ${url.replace(endpoints.httpBaseUrl, '')}`);
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
      expect(await settle(endConversation(endpoints, 'token', 'c1'))).toEqual({ value: undefined });
      expect(requests).toEqual(['POST /conversations/c1/end']);
    });

    it('calls again after 503 and after a network failure, waiting 1, 2, and 5 seconds', async () => {
      replies = [{ status: 503 }, NETWORK_FAILURE, { status: 503 }, { status: 200 }];
      const call = endConversation(endpoints, 'token', 'c1');
      for (const [waitMs, sent] of [[0, 1], [999, 1], [1, 2], [2_000, 3], [4_999, 3], [1, 4]]) {
        await jest.advanceTimersByTimeAsync(waitMs);
        expect(requests).toHaveLength(sent);
      }
      await expect(call).resolves.toBeUndefined();
    });

    it('gives up after three retries and reports the server message', async () => {
      const unavailable = { status: 503, body: { message: ['Temporarily unavailable.'] } };
      replies = [unavailable, unavailable, unavailable, unavailable, unavailable];
      const { error } = await settle(endConversation(endpoints, 'token', 'c1'));
      expect(requests).toHaveLength(4);
      expect(error?.message).toBe('Temporarily unavailable.');
    });

    it('calls again when a request got no answer within 15 seconds', async () => {
      replies = [NO_ANSWER, { status: 200 }];
      const call = endConversation(endpoints, 'token', 'c1');
      for (const [waitMs, sent] of [[0, 1], [14_999, 1], [1, 1], [999, 1], [1, 2]]) {
        await jest.advanceTimersByTimeAsync(waitMs);
        expect(requests).toHaveLength(sent);
      }
      await expect(call).resolves.toBeUndefined();
      // The timeout of a request that was answered is cancelled.
      expect(jest.getTimerCount()).toBe(0);
    });

    it.each([401, 403])('does not retry %i', async (status) => {
      replies = [{ status, body: { message: ['Permission denied.'] } }];
      const { error } = await settle(endConversation(endpoints, 'token', 'c1'));
      expect(requests).toHaveLength(1);
      expect(error?.message).toBe('Permission denied.');
    });
  });

  describe('createConversation and saveInterpretationSettings', () => {
    const saveSettings = () => saveInterpretationSettings(endpoints, 'token', 'c1', 'ko-KR', 'en-US', true);

    it('retry 503', async () => {
      const created = { status: 200, body: { conversation_id: 'c1' } };
      replies = [{ status: 503 }, created, { status: 503 }, { status: 200 }];
      expect(await settle(createConversation(endpoints, 'token'))).toEqual({ value: 'c1' });
      expect(await settle(saveSettings())).toEqual({ value: undefined });
      expect(requests).toHaveLength(4);
    });

    // The Conversation may exist even though its response was lost; a second create would
    // leave one that nobody ends.
    it('do not retry a network failure', async () => {
      replies = [NETWORK_FAILURE, NETWORK_FAILURE];
      expect((await settle(createConversation(endpoints, 'token'))).error?.message).toBe('Network request failed');
      expect((await settle(saveSettings())).error?.message).toBe('Network request failed');
      expect(requests).toHaveLength(2);
    });

    it('fail after 15 seconds without an answer, and do not retry', async () => {
      replies = [NO_ANSWER, NO_ANSWER];
      const created = createConversation(endpoints, 'token').catch((error: Error) => error.message);
      await jest.advanceTimersByTimeAsync(14_999);
      expect(jest.getTimerCount()).toBe(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(await created).toBe('The request timed out.');
      expect((await settle(saveSettings())).error?.message).toBe('The request timed out.');
      expect(requests).toHaveLength(2);
    });
  });
});
