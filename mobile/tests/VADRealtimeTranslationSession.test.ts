import { RealtimeTranslationSession } from '../src/realtime/RealtimeTranslationSession';
import type { MicrophoneRecorder } from '../src/audio/NativeMicrophone';
import type { PcmAudioFrame } from '../src/audio/PcmFramePipeline';
import type { VadDecision, VadRuntime } from '../src/audio/VADClient';

const microphone: MicrophoneRecorder = {
  prepare: async () => {},
  start: async () => {},
  pause: async () => {},
  resume: async () => {},
  stop: async () => {},
};
const runtime: VadRuntime = {
  initialize: async () => {},
  process: async () => 0,
  reset: () => {},
  dispose: async () => {},
};
const audioFrame: PcmAudioFrame = {
  samples: new Float32Array(320),
  pcm16: new ArrayBuffer(640),
  sampleCount: 320,
};

describe('RealtimeTranslationSession client VAD wire ordering', () => {
  it('sends a boundary at the current frame cursor before that frame PCM', () => {
    const sent: unknown[] = [];
    const session = new RealtimeTranslationSession(
      { httpBaseUrl: 'https://example.test', websocketBaseUrl: 'wss://example.test', appOrigin: 'https://example.test' },
      microphone,
      'token',
      runtime,
    );
    const internal = session as any;
    internal.clientVad = true;
    internal.snapshot = { ...session.getSnapshot(), phase: 'recording' };
    internal.audioSocket = { readyState: WebSocket.OPEN, send: (value: unknown) => sent.push(value) };

    const opened: VadDecision = {
      enabled: true,
      ready: true,
      mode: 'silero',
      gate: 'open',
      probability: 0.8,
      rms: 0,
      isSpeech: true,
      level: 'strong',
      event: 'speech_gate_opened',
    };
    internal.sendVadAudioFrame(audioFrame, opened, 0);

    expect(JSON.parse(sent[0] as string)).toMatchObject({
      type: 'audio.status',
      status_seq: 1,
      boundary_sample: 0,
      vad: { enabled: true, event: 'speech_gate_opened' },
    });
    expect(sent[1]).toBe(audioFrame.pcm16);

    const closed: VadDecision = { ...opened, gate: 'closed', probability: 0, isSpeech: false, level: 'off', event: 'speech_gate_closed' };
    internal.sendVadAudioFrame(audioFrame, closed, 320);
    expect(JSON.parse(sent[2] as string)).toMatchObject({
      status_seq: 2,
      boundary_sample: 320,
      vad: { enabled: true, event: 'speech_gate_closed' },
    });
    expect(sent[3]).toBe(audioFrame.pcm16);
  });

  it.each(['capturing', 'paused', 'idle'] as const)(
    'sends disabled VAD state for the %s lifecycle status',
    (state) => {
      const sent: unknown[] = [];
      const session = new RealtimeTranslationSession(
        { httpBaseUrl: 'https://example.test', websocketBaseUrl: 'wss://example.test', appOrigin: 'https://example.test' },
        microphone,
        'token',
        runtime,
      );
      const internal = session as any;
      internal.clientVad = false;
      internal.audioSocket = { readyState: WebSocket.OPEN, send: (value: unknown) => sent.push(value) };

      internal.sendAudioStatus(state);

      expect(JSON.parse(sent[0] as string)).toMatchObject({
        mic: { state },
        vad: { enabled: false },
      });
      expect(JSON.parse(sent[0] as string).vad.event).toBeUndefined();
    },
  );
});
