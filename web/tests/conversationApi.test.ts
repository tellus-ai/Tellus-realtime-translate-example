import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationAccessTokens } from '../src/api/accessTokens';
import {
  buildAudioWebSocketUrl,
  buildResultWebSocketUrl,
  createConversation,
  endConversation,
  issueAccessToken,
  saveInterpretationSettings,
} from '../src/api/conversationApi';

const endpoints = { apiBaseUrl: 'https://example.test', websocketBaseUrl: 'wss://example.test' };
const NETWORK_FAILURE = 'network failure';
const NO_ANSWER = 'no answer';

type Reply = { status: number; body?: unknown } | typeof NETWORK_FAILURE | typeof NO_ANSWER;

describe('conversation API', () => {
  let replies: Reply[];
  let requests: string[];
  let bodies: unknown[];
  let headers: unknown[];

  beforeEach(() => {
    vi.useFakeTimers();
    replies = [];
    requests = [];
    bodies = [];
    headers = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      requests.push(`${init.method} ${url.replace(endpoints.apiBaseUrl, '')}`);
      headers.push(init.headers);
      bodies.push(typeof init.body === 'string' ? JSON.parse(init.body) : undefined);
      const reply = replies.shift() ?? { status: 200, body: {} };
      if (reply === NETWORK_FAILURE) throw new TypeError('Failed to fetch');
      if (reply === NO_ANSWER) {
        // The request ends only when the client gives it up.
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        });
      }
      return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status });
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
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
      expect(await settle(endConversation(endpoints, 'c1'))).toEqual({ value: undefined });
      expect(requests).toEqual(['POST /v1/conversations/c1/end']);
    });

    it('calls again after 503 and after a network failure, waiting 1, 2, and 5 seconds', async () => {
      replies = [{ status: 503 }, NETWORK_FAILURE, { status: 503 }, { status: 200 }];
      const call = endConversation(endpoints, 'c1');
      for (const [waitMs, sent] of [[0, 1], [999, 1], [1, 2], [2_000, 3], [4_999, 3], [1, 4]]) {
        await vi.advanceTimersByTimeAsync(waitMs);
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

    it('gives up a request that is not answered within 15 seconds and handles it as no response', async () => {
      replies = [NO_ANSWER, { status: 200 }];
      const call = endConversation(endpoints, 'c1');
      await vi.advanceTimersByTimeAsync(14_999);
      expect(requests).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(requests).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(requests).toHaveLength(2);
      await expect(call).resolves.toBeUndefined();
    });

    // This example's server answers 502 or 504 when Tellus could not be reached or was too slow.
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

    it('use the /v1 routes: an empty create, then the two languages and client VAD as settings', async () => {
      replies = [{ status: 201, body: { statusCode: '201', message: ['ok'], data: { conversation_id: 'c1' } } }];
      expect(await settle(createConversation(endpoints))).toEqual({ value: 'c1' });
      expect(await settle(saveSettings())).toEqual({ value: undefined });
      expect(requests).toEqual(['POST /v1/conversations', 'POST /v1/conversations/c1/settings']);
      expect(bodies).toEqual([
        undefined,
        { languages: ['ko-KR', 'en-US'], transcription: { client_vad: true } },
      ]);
    });

    it('retry 503', async () => {
      const created = { status: 200, body: { conversation_id: 'c1' } };
      replies = [{ status: 503 }, created, { status: 503 }, { status: 200 }];
      expect(await settle(createConversation(endpoints))).toEqual({ value: 'c1' });
      expect(await settle(saveSettings())).toEqual({ value: undefined });
      expect(requests).toHaveLength(4);
    });

    // The Conversation may exist even though its response was lost; a second create would
    // leave one that nobody ends.
    it('do not retry a network failure', async () => {
      replies = [NETWORK_FAILURE, NETWORK_FAILURE];
      expect((await settle(createConversation(endpoints))).error?.message).toBe('Failed to fetch');
      expect((await settle(saveSettings())).error?.message).toBe('Failed to fetch');
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

    it('send no credential: the example server adds the API key', async () => {
      replies = [{ status: 201, body: { conversation_id: 'c1' } }];
      await settle(createConversation(endpoints));
      await settle(saveSettings());
      expect(headers).toEqual([
        { 'Content-Type': 'application/json', 'X-Tellus-Example-Api': '1' },
        { 'Content-Type': 'application/json', 'X-Tellus-Example-Api': '1' },
      ]);
    });

    it('do not retry a request that timed out', async () => {
      replies = [NO_ANSWER, NO_ANSWER];
      expect((await settle(createConversation(endpoints))).error?.message).toBe('The request timed out.');
      expect((await settle(saveSettings())).error?.message).toBe('The request timed out.');
      expect(requests).toHaveLength(2);
    });
  });

  describe('issueAccessToken', () => {
    const issued = (token: string, expiresAtMs: number) => (
      { status: 201, body: { access_token: token, expires_at_ms: expiresAtMs } }
    );

    it('asks for a token of one Conversation and reads the response, which has no envelope', async () => {
      replies = [issued('tl_at_1', 1_000)];
      expect(await settle(issueAccessToken(endpoints, 'c1'))).toEqual({
        value: { token: 'tl_at_1', expiresAtMs: 1_000 },
      });
      expect(requests).toEqual(['POST /v1/access-tokens']);
      expect(bodies).toEqual([{ session_kind: 'conversation', session_id: 'c1' }]);
    });

    it('reports the detail of an error response', async () => {
      replies = [{ status: 410, body: { detail: 'Session has already ended' } }];
      const { error } = await settle(issueAccessToken(endpoints, 'c1'));
      expect(error).toMatchObject({ message: 'Session has already ended', status: 410 });
    });

    // Unlike a create request, issuing a token twice leaves nothing behind.
    it('calls again after a network failure', async () => {
      replies = [NETWORK_FAILURE, issued('tl_at_1', 1_000)];
      expect((await settle(issueAccessToken(endpoints, 'c1'))).value?.token).toBe('tl_at_1');
      expect(requests).toHaveLength(2);
    });

    it('rejects a response without a token', async () => {
      replies = [{ status: 201, body: {} }];
      const { error } = await settle(issueAccessToken(endpoints, 'c1'));
      expect(error?.message).toBe('Access token response is missing access_token or expires_at_ms.');
    });
  });

  describe('ConversationAccessTokens', () => {
    const LIFETIME_MS = 15 * 60_000;
    const next = (token: string) => (
      { status: 201, body: { access_token: token, expires_at_ms: Date.now() + LIFETIME_MS } }
    );

    it('reuses a token until one minute before it expires, then issues the next', async () => {
      const tokens = new ConversationAccessTokens(endpoints, 'c1');
      replies = [next('first')];
      await expect(tokens.get()).resolves.toBe('first');
      await vi.advanceTimersByTimeAsync(LIFETIME_MS - 60_001);
      await expect(tokens.get()).resolves.toBe('first');
      expect(requests).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1);
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

  describe('WebSocket URLs', () => {
    const ws = { ...endpoints, websocketBaseUrl: 'wss://example.test' };

    it('carry the access token, and never a query the server does not accept', () => {
      expect(buildResultWebSocketUrl(ws, 'a/b', 'tl_at_x.y')).toBe(
        'wss://example.test/v1/conversations/a%2Fb/results?token=tl_at_x.y',
      );
      expect(buildAudioWebSocketUrl(ws, 'a/b', 'opus', 'tl_at_x.y')).toBe(
        'wss://example.test/v1/audio?conversation_id=a%2Fb&audio_format=opus&token=tl_at_x.y',
      );
    });

    it('add after_order_seq to Result, including 0', () => {
      expect(buildResultWebSocketUrl(ws, 'c1', 't', 0)).toBe(
        'wss://example.test/v1/conversations/c1/results?token=t&after_order_seq=0',
      );
      expect(buildResultWebSocketUrl(ws, 'c1', 't', 12)).toContain('after_order_seq=12');
    });
  });
});
