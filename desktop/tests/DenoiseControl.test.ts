import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DenoiseStatus, DenoiseToggle } from '../src/components/DenoiseControl';
import { TranslationExample } from '../src/components/TranslationExample';
import type { DenoiseSnapshot } from '../electron/shared/realtimeTypes';

const snapshot: DenoiseSnapshot = { enabled: true, applied: null, updating: false, error: null };

describe('denoise controls', () => {
  it('allows choosing SDK denoise before starting', () => {
    const html = renderToStaticMarkup(createElement(DenoiseToggle, { snapshot, disabled: false, audioSdkEnabled: true, onChange: vi.fn() }));
    expect(html).toContain('checked=""');
    expect(html).not.toContain('disabled=""');
  });

  it.each([
    { disabled: true, audioSdkEnabled: true, updating: false },
    { disabled: false, audioSdkEnabled: false, updating: false },
    { disabled: false, audioSdkEnabled: true, updating: true },
  ])('locks the toggle when unavailable or changing: %j', (state) => {
    const html = renderToStaticMarkup(createElement(DenoiseToggle, { ...state, snapshot: { ...snapshot, updating: state.updating }, onChange: vi.fn() }));
    expect(html).toContain('disabled=""');
    if (!state.audioSdkEnabled) expect(html).not.toContain('checked=""');
  });

  it('distinguishes the selected value from the SDK applied value and displays errors', () => {
    const render = (applied: boolean | null, error: string | null = null) => renderToStaticMarkup(createElement(DenoiseStatus, {
      snapshot: { ...snapshot, applied, error }, audioSdkEnabled: true,
    }));
    expect(render(null)).toContain('Not started · On selected');
    expect(render(false)).toContain('Audio SDK denoise: Off');
    expect(render(true)).toContain('Audio SDK denoise: On');
    expect(render(true, 'Unable to change denoise')).toContain('role="alert"');
  });
});


const screen = vi.hoisted(() => ({ phase: 'idle' }));
vi.mock('../src/config/realtimeSpeechConfig', () => ({ realtimeSpeechConfig: {
  audioSdkEnabled: true, accessToken: 'token', accessTokenConfigured: true,
} }));
vi.mock('../src/hooks/useRealtimeTranslation', () => ({ useRealtimeTranslation: () => ({
  phase: screen.phase, audioSdkReady: false, rows: [], error: null,
  resultConnection: 'closed', audioConnection: 'closed',
  denoise: { enabled: true, applied: null, updating: false, error: null },
  vad: { enabled: false, ready: false, mode: 'disabled', gate: 'closed', level: 'off' },
  start() {}, pause() {}, resume() {}, stop() {}, setDenoiseEnabled() {},
}) }));

it.each([
  ['idle', false], ['ended', false], ['error', false],
  ['creating', true], ['configuring', true], ['connecting', true], ['stopping', true], ['reconnecting', true],
  ['recording', false], ['paused', false],
])('wires denoise availability in the full screen for %s', (phase, locked) => {
  screen.phase = String(phase);
  const html = renderToStaticMarkup(createElement(TranslationExample));
  const toggle = html.match(/<input[^>]*aria-label="Audio SDK denoise"[^>]*>/)?.[0];
  expect(toggle).toBeDefined();
  expect(toggle?.includes('disabled=""')).toBe(locked);
});
