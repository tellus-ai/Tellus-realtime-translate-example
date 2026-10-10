import type { AudioCaptureConfig, AudioEngine } from '@tellus-ai/audio-sdk-desktop';
import type { MicrophoneCapture } from '../realtime/RealtimeTranslationSession';

const AUDIO_CAPTURE_CONFIG: AudioCaptureConfig = {
  micEnabled: true,
  speakerEnabled: false,
  // Same default as the Tellus desktop app. The engine DSP chain still runs.
  denoiseEnabled: false,
  vadEnabled: false,
  processing: { sampleRate: 16_000, chunkDurationMs: 20 },
  transport: { codec: 'opus', bitrateBps: 64_000 },
};

let enginePromise: Promise<AudioEngine> | null = null;

/**
 * Loads the native engine once with client VAD disabled. The SDK is imported lazily so a missing
 * native binary surfaces as a session error instead of crashing the main process at startup.
 */
export function initializeAudioEngine(): Promise<AudioEngine> {
  if (!enginePromise) {
    const promise = import('@tellus-ai/audio-sdk-desktop')
      .then(({ AudioEngine }) => AudioEngine.init(AUDIO_CAPTURE_CONFIG))
      .catch((error: unknown) => {
        throw new Error(`Audio SDK is required but could not be initialized: ${error instanceof Error ? error.message : String(error)}`);
      });
    enginePromise = promise;
    promise.catch(() => {
      if (enginePromise === promise) enginePromise = null;
    });
  }
  return enginePromise;
}

export async function createMicrophoneCapture(
  requestMicrophoneAccess: () => Promise<boolean>,
): Promise<MicrophoneCapture> {
  if (!(await requestMicrophoneAccess())) {
    throw new Error('Microphone access is denied. Allow it in System Settings > Privacy & Security > Microphone.');
  }
  const engine = await initializeAudioEngine();
  if (!engine.getStatus().initialized) throw new Error('Audio SDK is required but is not initialized.');
  return Object.assign(engine.createCapture(), { audioSdkReady: true });
}
