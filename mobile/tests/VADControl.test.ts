import { act, createElement } from 'react';
import { Switch } from 'react-native';
import { create, type ReactTestRenderer } from 'react-test-renderer';
import { VADToggle } from '../src/components/VADControl';
import { TranslationExample } from '../src/components/TranslationExample';
import { useRealtimeTranslation } from '../src/hooks/useRealtimeTranslation';

const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
const previousActEnvironment = environment.IS_REACT_ACT_ENVIRONMENT;
beforeAll(() => { environment.IS_REACT_ACT_ENVIRONMENT = true; });
afterAll(() => { environment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment; });

describe('VAD switch availability', () => {
  it('allows VAD without SDK, locks it off with SDK, and unlocks it after SDK stops', async () => {
    const onChange = jest.fn();
    const props = { enabled: true, disabled: false, audioSdkEnabled: false, onChange };
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(createElement(VADToggle, props)); });
    expect(renderer.root.findByType(Switch).props.disabled).toBe(false);
    expect(renderer.root.findByType(Switch).props.value).toBe(true);
    await act(async () => { renderer.root.findByType(Switch).props.onValueChange(false); });
    expect(onChange).toHaveBeenCalledWith(false);

    await act(async () => { renderer.update(createElement(VADToggle, { ...props, audioSdkEnabled: true })); });
    expect(renderer.root.findByType(Switch).props.disabled).toBe(true);
    expect(renderer.root.findByType(Switch).props.value).toBe(false);
    onChange.mockClear();
    await act(async () => { renderer.root.findByType(Switch).props.onValueChange(true); });
    expect(onChange).not.toHaveBeenCalled();

    await act(async () => { renderer.update(createElement(VADToggle, props)); });
    expect(renderer.root.findByType(Switch).props.disabled).toBe(false);
    await act(async () => { renderer.root.findByType(Switch).props.onValueChange(true); });
    expect(onChange).toHaveBeenCalledWith(true);
    await act(async () => { renderer.unmount(); });
  });
});

let mockSdkEnabled = true;
jest.mock('../src/config/realtimeSpeechConfig', () => ({
  realtimeSpeechConfig: { accessToken: 'token', get audioSdkEnabled() { return mockSdkEnabled; } },
}));
jest.mock('../src/hooks/useRealtimeTranslation', () => ({ useRealtimeTranslation: jest.fn() }));
const mockRealtime = jest.mocked(useRealtimeTranslation);

function unpreparedSession(phase: 'idle' | 'ended' | 'error') {
  mockRealtime.mockReturnValue({
    phase, conversationId: null, audioSdkReady: false, rows: [], error: null,
    resultConnection: 'closed', audioConnection: 'closed',
    vad: { enabled: false, ready: false, mode: 'disabled', gate: 'closed' },
    start: jest.fn(), pause: jest.fn(), resume: jest.fn(), stop: jest.fn(),
  });
}

describe('SDK configuration locks the full screen independently of capture readiness', () => {
  it.each(['idle', 'ended', 'error'] as const)('keeps VAD locked with an unprepared SDK capture in %s', async (phase) => {
    mockSdkEnabled = true;
    unpreparedSession(phase);
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(createElement(TranslationExample)); });
    expect(renderer.root.findByType(Switch).props.disabled).toBe(true);
    expect(renderer.root.findByType(Switch).props.value).toBe(false);
    await act(async () => { renderer.root.findByType(Switch).props.onValueChange(true); });
    expect(renderer.root.findByType(Switch).props.value).toBe(false);
    await act(async () => { renderer.unmount(); });
  });

  it('clears a retained VAD selection when SDK mode is enabled without capture', async () => {
    mockSdkEnabled = false;
    unpreparedSession('idle');
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(createElement(TranslationExample)); });
    expect(renderer.root.findByType(Switch).props.disabled).toBe(false);
    await act(async () => { renderer.root.findByType(Switch).props.onValueChange(true); });
    expect(renderer.root.findByType(Switch).props.value).toBe(true);
    mockSdkEnabled = true;
    await act(async () => { renderer.update(createElement(TranslationExample)); });
    expect(renderer.root.findByType(Switch).props.disabled).toBe(true);
    expect(renderer.root.findByType(Switch).props.value).toBe(false);
    await act(async () => { renderer.unmount(); });
  });
});
