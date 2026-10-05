import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveRealtimeSpeechConfig } from '../electron/config';
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
  it('uses the staging server by default and trims values', () => {
    expect(resolveRealtimeSpeechConfig({ API_KEY: ' token ' })).toEqual({
      accessToken: 'token',
      httpBaseUrl: 'https://stgrtsapi.tellus.ai.kr',
      websocketBaseUrl: 'wss://stgrtsapi.tellus.ai.kr',
    });
    expect(resolveRealtimeSpeechConfig({
      REALTIME_SPEECH_HTTP_URL: 'https://rts.example.test/',
      REALTIME_SPEECH_WS_URL: 'wss://rts.example.test//',
    })).toMatchObject({
      httpBaseUrl: 'https://rts.example.test',
      websocketBaseUrl: 'wss://rts.example.test',
    });
  });

  it('allows plain-text transport only for localhost', () => {
    expect(resolveRealtimeSpeechConfig({
      REALTIME_SPEECH_HTTP_URL: 'http://localhost:8000',
      REALTIME_SPEECH_WS_URL: 'ws://127.0.0.1:8000',
    })).toMatchObject({ httpBaseUrl: 'http://localhost:8000', websocketBaseUrl: 'ws://127.0.0.1:8000' });
    expect(() => resolveRealtimeSpeechConfig({ REALTIME_SPEECH_HTTP_URL: 'http://rts.example.test' }))
      .toThrow('REALTIME_SPEECH_HTTP_URL must use https:');
    expect(() => resolveRealtimeSpeechConfig({ REALTIME_SPEECH_WS_URL: 'https://rts.example.test' }))
      .toThrow('REALTIME_SPEECH_WS_URL must use wss:');
  });
});
