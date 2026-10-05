import { describe, expect, it, vi } from 'vitest';
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
