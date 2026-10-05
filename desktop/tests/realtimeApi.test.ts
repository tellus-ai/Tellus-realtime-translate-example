import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RealtimeApiError, createRealtimeApi, toDesktopError } from '../electron/realtimeApi';

const config = { httpBaseUrl: 'https://api.example.test', accessToken: 'token-1' };

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe('createRealtimeApi', () => {
  it('creates a conversation with the bearer token and unwraps the envelope', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      statusCode: '201',
      message: ['ok'],
      data: { conversation_id: 'conversation-1' },
    }, 201));
    const api = createRealtimeApi(config, fetchMock);

    await expect(api.createConversation()).resolves.toBe('conversation-1');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.test/conversations');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer token-1' });
    expect(JSON.parse(String(init.body))).toEqual({
      max_concurrent_viewers: 10,
      conversation_audio_mode: 'single_speaker',
    });
  });

  it('saves interpretation settings with the client VAD flag and default translation', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ statusCode: '200', message: ['ok'], data: {} }));
    const api = createRealtimeApi(config, fetchMock);

    await api.saveInterpretationSettings('a/b', { sourceLanguage: 'ko-KR', targetLanguage: 'en-US', clientVad: true });

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.test/conversations/a%2Fb/interpretation-settings');
    expect(JSON.parse(String(init.body))).toEqual({
      languages: ['ko-KR', 'en-US'],
      transcription: { client_vad: true },
      translation: {},
    });
  });

  it('ends a conversation without a request body', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ statusCode: '200', message: ['ok'], data: { ended: true } }));
    const api = createRealtimeApi(config, fetchMock);

    await api.endConversation('conversation-1');

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.example.test/conversations/conversation-1/end');
    expect(init.body).toBeUndefined();
  });

  it('surfaces the server message and status of a failed request', async () => {
    const api = createRealtimeApi(config, async () => jsonResponse({ statusCode: '401', message: ['Invalid token'] }, 401));

    const error = await api.createConversation().catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RealtimeApiError);
    expect(toDesktopError(error)).toEqual({ message: 'Invalid token', status: 401, messages: ['Invalid token'] });
  });

  it('rejects without a request when API_KEY is missing', async () => {
    const fetchMock = vi.fn();
    const api = createRealtimeApi({ ...config, accessToken: '' }, fetchMock);

    await expect(api.createConversation()).rejects.toThrow('Set API_KEY in desktop/.env');
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
    requests.push(`${init.method} ${url.replace(config.httpBaseUrl, '')}`);
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
      expect(requests).toEqual(['POST /conversations/c1/end']);
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
  });
});
