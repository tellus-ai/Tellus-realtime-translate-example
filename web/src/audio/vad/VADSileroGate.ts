import {
  VAD_MIN_SILENCE_SAMPLES,
  VAD_NEGATIVE_THRESHOLD,
  VAD_POSITIVE_THRESHOLD,
} from './VADConfig';
import type { GateState, VadDecision, VadEvent } from './VADTypes';
import { resolveVadLevel } from '../../realtime/VADAudioStatus';

export class VADSileroGate {
  private gate: GateState['gate'] = 'closed';
  private silenceSamples = 0;
  private lastSpeechSampleEnd: number | null = null;

  reset(): void {
    this.gate = 'closed';
    this.silenceSamples = 0;
    this.lastSpeechSampleEnd = null;
  }

  process(probability: number, sampleStart: number, sampleCount: number): VadDecision {
    const normalizedProbability = Number.isFinite(probability)
      ? Math.max(0, Math.min(1, probability))
      : 0;
    const wasOpen = this.gate === 'open';
    const speech = normalizedProbability >= VAD_POSITIVE_THRESHOLD
      ? true
      : normalizedProbability <= VAD_NEGATIVE_THRESHOLD
        ? false
        : wasOpen;
    let event: VadEvent | undefined;

    if (speech) {
      this.silenceSamples = 0;
      this.lastSpeechSampleEnd = sampleStart + sampleCount;
      if (!wasOpen) {
        this.gate = 'open';
        event = 'speech_gate_opened';
      }
    } else if (wasOpen) {
      this.silenceSamples += sampleCount;
      if (this.silenceSamples >= VAD_MIN_SILENCE_SAMPLES) {
        this.gate = 'closed';
        this.silenceSamples = 0;
        event = 'speech_gate_closed';
      }
    }

    const isSpeech = this.gate === 'open';
    return {
      enabled: true,
      ready: true,
      mode: 'silero',
      gate: this.gate,
      isSpeech,
      probability: normalizedProbability,
      level: resolveVadLevel(true, isSpeech, normalizedProbability),
      lastSpeechSampleEnd: this.lastSpeechSampleEnd,
      ...(event ? { event } : {}),
    };
  }
}
