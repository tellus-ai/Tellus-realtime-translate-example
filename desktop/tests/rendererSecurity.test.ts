import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveExampleApiUrl, resolveRealtimeSpeechConfig } from '../electron/config';
import { resolveRendererFile } from '../electron/rendererProtocol';
import { buildContentSecurityPolicy, isTrustedRendererUrl } from '../electron/security';

const root = join('/', 'app', 'dist', 'renderer');

describe('resolveRendererFile', () => {
  it('serves files inside the renderer root', () => {
    expect(resolveRendererFile('tellus-translate://app/', root)).toBe(join(root, 'index.html'));
    expect(resolveRendererFile('tellus-translate://app/ort/ort-wasm-simd-threaded.wasm?v=1', root))
      .toBe(join(root, 'ort', 'ort-wasm-simd-threaded.wasm'));
  });

  it('rejects other hosts, schemes, and paths outside the root', () => {
    expect(resolveRendererFile('tellus-translate://other/index.html', root)).toBeNull();
    expect(resolveRendererFile('file:///app/dist/renderer/index.html', root)).toBeNull();
    // The URL parser collapses encoded dot segments, so they cannot climb above the root.
    expect(resolveRendererFile('tellus-translate://app/%2e%2e/%2e%2e/main.js', root)).toBe(join(root, 'main.js'));
    expect(resolveRendererFile('tellus-translate://app/..%2Felectron%2Fmain.js', root)).toBeNull();
    expect(resolveRendererFile('tellus-translate://app/%00', root)).toBeNull();
    expect(resolveRendererFile('tellus-translate://app/%E0%A4%A', root)).toBeNull();
  });
});

describe('isTrustedRendererUrl', () => {
  it('trusts only the packaged renderer origin in production', () => {
    expect(isTrustedRendererUrl('tellus-translate://app/index.html', null)).toBe(true);
    expect(isTrustedRendererUrl('tellus-translate://evil/index.html', null)).toBe(false);
    expect(isTrustedRendererUrl('http://127.0.0.1:5173/', null)).toBe(false);
    expect(isTrustedRendererUrl('https://example.com/', null)).toBe(false);
  });

  it('trusts only the dev server origin in development', () => {
    const devServerUrl = 'http://127.0.0.1:5173/';
    expect(isTrustedRendererUrl('http://127.0.0.1:5173/src/main.tsx', devServerUrl)).toBe(true);
    expect(isTrustedRendererUrl('http://127.0.0.1:5174/', devServerUrl)).toBe(false);
    expect(isTrustedRendererUrl('tellus-translate://app/index.html', devServerUrl)).toBe(false);
  });
});

describe('buildContentSecurityPolicy', () => {
  it('keeps the renderer off the network', () => {
    expect(buildContentSecurityPolicy()).toContain("connect-src 'self';");
  });
});

describe('resolveRealtimeSpeechConfig', () => {
  it('uses the public speech server by default and trims values', () => {
    expect(resolveRealtimeSpeechConfig({})).toEqual({
      audioSdkEnabled: true,
      websocketBaseUrl: 'wss://public.speech.tellus.ai.kr',
      exampleApiUrl: null,
    });
    expect(resolveRealtimeSpeechConfig({
      REALTIME_SPEECH_WS_URL: 'wss://rts.example.test//',
      TELLUS_EXAMPLE_API_URL: ' https://backend.example.test/__tellus/api/ ',
    })).toMatchObject({
      websocketBaseUrl: 'wss://rts.example.test',
      exampleApiUrl: 'https://backend.example.test/__tellus/api',
    });
  });

  it('never reads the API key: the main process does not hold it', () => {
    const config = resolveRealtimeSpeechConfig({ API_KEY: 'tl_test_secret-key', REALTIME_SPEECH_HTTP_URL: 'https://x.test' });
    expect(JSON.stringify(config)).not.toContain('secret');
    expect(Object.keys(config).sort()).toEqual(['audioSdkEnabled', 'exampleApiUrl', 'websocketBaseUrl']);
  });

  it('allows plain-text transport only for localhost', () => {
    expect(resolveRealtimeSpeechConfig({
      REALTIME_SPEECH_WS_URL: 'ws://127.0.0.1:8000',
      TELLUS_EXAMPLE_API_URL: 'http://localhost:8787/__tellus/api',
    })).toMatchObject({ websocketBaseUrl: 'ws://127.0.0.1:8000', exampleApiUrl: 'http://localhost:8787/__tellus/api' });
    expect(() => resolveRealtimeSpeechConfig({ TELLUS_EXAMPLE_API_URL: 'http://backend.example.test' }))
      .toThrow('TELLUS_EXAMPLE_API_URL must use https:');
    expect(() => resolveRealtimeSpeechConfig({ REALTIME_SPEECH_WS_URL: 'https://rts.example.test' }))
      .toThrow('REALTIME_SPEECH_WS_URL must use wss:');
    expect(() => resolveRealtimeSpeechConfig({ TELLUS_EXAMPLE_API_URL: 'https://user:pass@backend.example.test' }))
      .toThrow('TELLUS_EXAMPLE_API_URL must not contain credentials, a query, or a hash.');
  });

  it('disables SDK mode only when explicitly configured off', () => {
    expect(resolveRealtimeSpeechConfig({ TELLUS_AUDIO_SDK_ENABLED: ' false ' }).audioSdkEnabled).toBe(false);
    expect(resolveRealtimeSpeechConfig({ TELLUS_AUDIO_SDK_ENABLED: 'true' }).audioSdkEnabled).toBe(true);
  });
});

describe('resolveExampleApiUrl', () => {
  it('prefers TELLUS_EXAMPLE_API_URL, then the routes of the npm run dev server', () => {
    expect(resolveExampleApiUrl('https://backend.example.test/api', 'http://127.0.0.1:5173/')).toBe('https://backend.example.test/api');
    expect(resolveExampleApiUrl(null, 'http://127.0.0.1:5173/')).toBe('http://127.0.0.1:5173/__tellus/api');
  });

  it('is null without either, as in a packaged app without TELLUS_EXAMPLE_API_URL', () => {
    expect(resolveExampleApiUrl(null, null)).toBeNull();
  });
});
