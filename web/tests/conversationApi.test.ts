import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createConversation,
  endConversation,
  saveInterpretationSettings,
} from '../src/api/conversationApi';

const endpoints = { httpBaseUrl: 'https://example.test', websocketBaseUrl: 'wss://example.test' };
const NETWORK_FAILURE = 'network failure';
const NO_ANSWER = 'no answer';

type Reply = { status: number; body?: unknown } | typeof NETWORK_FAILURE | typeof NO_ANSWER;

describe('conversation API', () => {
  let replies: Reply[];
  let requests: string[];

  beforeEach(() => {
    vi.useFakeTimers();
    replies = [];
    requests = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      requests.push(`${init.method} ${url.replace(endpoints.httpBaseUrl, '')}`);
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
      expect(await settle(endConversation(endpoints, 'token', 'c1'))).toEqual({ value: undefined });
      expect(requests).toEqual(['POST /conversations/c1/end']);
    });

    it('calls again after 503 and after a network failure, waiting 1, 2, and 5 seconds', async () => {
      replies = [{ status: 503 }, NETWORK_FAILURE, { status: 503 }, { status: 200 }];
      const call = endConversation(endpoints, 'token', 'c1');
      for (const [waitMs, sent] of [[0, 1], [999, 1], [1, 2], [2_000, 3], [4_999, 3], [1, 4]]) {
        await vi.advanceTimersByTimeAsync(waitMs);
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

    it('gives up a request that is not answered within 15 seconds and handles it as no response', async () => {
      replies = [NO_ANSWER, { status: 200 }];
      const call = endConversation(endpoints, 'token', 'c1');
      await vi.advanceTimersByTimeAsync(14_999);
      expect(requests).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(requests).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(requests).toHaveLength(2);
      await expect(call).resolves.toBeUndefined();
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
      expect((await settle(createConversation(endpoints, 'token'))).error?.message).toBe('Failed to fetch');
      expect((await settle(saveSettings())).error?.message).toBe('Failed to fetch');
      expect(requests).toHaveLength(2);
    });

    it('do not retry a request that timed out', async () => {
      replies = [NO_ANSWER, NO_ANSWER];
      expect((await settle(createConversation(endpoints, 'token'))).error?.message).toBe('The request timed out.');
      expect((await settle(saveSettings())).error?.message).toBe('The request timed out.');
      expect(requests).toHaveLength(2);
    });
  });
});
