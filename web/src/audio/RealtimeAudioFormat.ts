export type RealtimeAudioFormat = 'opus' | 'pcm16';

const REALTIME_SERVER_AUDIO_FORMATS: readonly RealtimeAudioFormat[] = ['opus', 'pcm16'];

interface WebCodecsGlobal {
  AudioData?: typeof AudioData;
  AudioEncoder?: typeof AudioEncoder;
}

export function isRealtimeOpusAudioEncodingSupported(): boolean {
  const webCodecs = globalThis as unknown as WebCodecsGlobal;
  return Boolean(webCodecs.AudioEncoder && webCodecs.AudioData);
}

export function resolveRealtimeAudioFormat(
  serverFormats: readonly RealtimeAudioFormat[] = REALTIME_SERVER_AUDIO_FORMATS,
): RealtimeAudioFormat {
  if (serverFormats.includes('opus') && isRealtimeOpusAudioEncodingSupported()) {
    return 'opus';
  }

  if (serverFormats.includes('pcm16')) {
    return 'pcm16';
  }

  throw new Error('No compatible realtime audio format is available.');
}
