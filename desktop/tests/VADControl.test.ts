import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { VADToggle } from '../src/components/VADControl';
import { TranslationExample } from '../src/components/TranslationExample';

describe('VAD toggle availability', () => {
  it('locks VAD off while SDK is enabled even with a previous VAD selection', () => {
    const html = renderToStaticMarkup(createElement(VADToggle, {
      enabled: true, disabled: false, audioSdkEnabled: true, onChange: vi.fn(),
    }));
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('checked=""');
    expect(html).toContain('Disabled while using audio-sdk');
  });

  it('allows selecting VAD without SDK and keeps an active session locked', () => {
    const props = { enabled: true, disabled: false, audioSdkEnabled: false, onChange: vi.fn() };
    const html = renderToStaticMarkup(createElement(VADToggle, props));
    expect(html).toContain('checked=""');
    expect(html).not.toContain('disabled=""');
    const active = renderToStaticMarkup(createElement(VADToggle, { ...props, disabled: true }));
    expect(active).toContain('disabled=""');
  });
});

const screen = vi.hoisted(() => ({ audioSdkEnabled: true, phase: 'idle' }));
vi.mock('../src/config/realtimeSpeechConfig', () => ({
  realtimeSpeechConfig: {
    accessToken: 'token', accessTokenConfigured: true,
    get audioSdkEnabled() { return screen.audioSdkEnabled; },
  },
}));
vi.mock('../src/hooks/useRealtimeTranslation', () => ({
  useRealtimeTranslation: () => ({
    phase: screen.phase, audioSdkReady: false, rows: [], error: null,
    resultConnection: 'closed', audioConnection: 'closed',
    vad: { enabled: false, ready: false, mode: 'disabled', gate: 'closed', level: 'off' },
    start() {}, pause() {}, resume() {}, stop() {},
  }),
}));

describe('SDK configuration locks the full screen independently of capture readiness', () => {
  it.each(['idle', 'ended', 'error'])('keeps VAD locked with an unprepared SDK capture in %s', (phase) => {
    screen.audioSdkEnabled = true;
    screen.phase = phase;
    const html = renderToStaticMarkup(createElement(TranslationExample));
    const checkbox = html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0];
    expect(checkbox).toContain('disabled=""');
    expect(checkbox).not.toContain('checked=""');
    expect(html).toContain('Audio SDK: 사용 중');
  });

  it('unlocks VAD only with explicitly disabled SDK configuration', () => {
    screen.audioSdkEnabled = false;
    screen.phase = 'idle';
    const html = renderToStaticMarkup(createElement(TranslationExample));
    const checkbox = html.match(/<input[^>]*type="checkbox"[^>]*>/)?.[0];
    expect(checkbox).not.toContain('disabled=""');
    expect(html).toContain('Audio SDK: 사용하지 않음');
  });
});
