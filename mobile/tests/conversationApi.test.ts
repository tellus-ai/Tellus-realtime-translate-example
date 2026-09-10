import { saveInterpretationSettings } from '../src/api/conversationApi';

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
