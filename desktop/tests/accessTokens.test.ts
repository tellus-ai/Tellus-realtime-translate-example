import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConversationAccessTokens } from '../electron/realtime/accessTokens';
import type { IssuedAccessToken } from '../electron/realtimeApi';

const LIFETIME_MS = 15 * 60_000;

describe('ConversationAccessTokens', () => {
  let issued: string[];
  let failures: Error[];
  const issue = vi.fn(async (): Promise<IssuedAccessToken> => {
    const failure = failures.shift();
    if (failure) throw failure;
    const token = `token-${issued.length + 1}`;
    issued.push(token);
    return { token, expiresAtMs: Date.now() + LIFETIME_MS };
  });

  beforeEach(() => {
    vi.useFakeTimers();
    issued = [];
    failures = [];
    issue.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reuses a token until one minute before it expires, then issues the next', async () => {
    const tokens = new ConversationAccessTokens(issue);
    await expect(tokens.get()).resolves.toBe('token-1');
    await vi.advanceTimersByTimeAsync(LIFETIME_MS - 60_001);
    await expect(tokens.get()).resolves.toBe('token-1');
    expect(issue).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    await expect(tokens.get()).resolves.toBe('token-2');
    expect(issue).toHaveBeenCalledTimes(2);
  });

  it('shares one request between callers that ask at the same time', async () => {
    const tokens = new ConversationAccessTokens(issue);
    await expect(Promise.all([tokens.get(), tokens.get()])).resolves.toEqual(['token-1', 'token-1']);
    expect(issue).toHaveBeenCalledTimes(1);
  });

  it('asks again after a failed request instead of keeping the failure', async () => {
    const tokens = new ConversationAccessTokens(issue);
    failures = [new Error('Invalid API key')];
    await expect(tokens.get()).rejects.toThrow('Invalid API key');
    await expect(tokens.get()).resolves.toBe('token-1');
  });
});
