import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isRealtimeOpusAudioEncodingSupported,
  resolveRealtimeAudioFormat,
} from '../src/audio/RealtimeAudioFormat';

describe('realtime audio format', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('prefers Opus when WebCodecs audio encoding is available', () => {
    vi.stubGlobal('AudioEncoder', class {});
    vi.stubGlobal('AudioData', class {});

    expect(isRealtimeOpusAudioEncodingSupported()).toBe(true);
    expect(resolveRealtimeAudioFormat()).toBe('opus');
  });

  it('falls back to PCM16 when WebCodecs audio encoding is unavailable', () => {
    vi.stubGlobal('AudioEncoder', undefined);
    vi.stubGlobal('AudioData', undefined);

    expect(isRealtimeOpusAudioEncodingSupported()).toBe(false);
    expect(resolveRealtimeAudioFormat()).toBe('pcm16');
  });

  it('fails when the server and runtime have no compatible format', () => {
    vi.stubGlobal('AudioEncoder', undefined);
    vi.stubGlobal('AudioData', undefined);

    expect(() => resolveRealtimeAudioFormat(['opus'])).toThrow(
      'No compatible realtime audio format is available.',
    );
  });
});
