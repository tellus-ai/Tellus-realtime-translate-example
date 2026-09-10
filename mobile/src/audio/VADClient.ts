import { Asset } from 'expo-asset';
import type { PcmAudioFrame } from './PcmFramePipeline';
import type { VadLevel, VadSnapshot } from './VADTypes';

export const CLIENT_VAD_POLICY = {
  sampleRate: 16_000,
  inferenceFrameSamples: 512,
  contextSamples: 64,
  stateSize: 2 * 1 * 128,
  positiveThreshold: 0.5,
  negativeThreshold: 0.35,
  silenceSamples: 8_800, // 550 ms at 16 kHz
  preSpeechSamples: 8_000, // documented SDK policy; PCM is always uploaded here
  maxConsecutiveErrors: 8,
  maxPendingFrames: 10, // 200 ms at the microphone's 20 ms frame size
} as const;

export type VadGateEvent = 'speech_gate_opened' | 'speech_gate_closed';

export interface VadDecision extends VadSnapshot {
  rms: number;
  event?: VadGateEvent;
}

export interface VadRuntime {
  initialize(): Promise<void>;
  process(samples: Float32Array): Promise<number>;
  reset(): void;
  dispose(): Promise<void>;
}

export class ConsecutiveVadErrorBudget {
  private count = 0;

  success(): void { this.count = 0; }
  reset(): void { this.count = 0; }

  failure(error: unknown): void {
    this.count += 1;
    if (this.count >= CLIENT_VAD_POLICY.maxConsecutiveErrors) {
      throw new Error(`Silero VAD inference failed ${CLIENT_VAD_POLICY.maxConsecutiveErrors} consecutive times: ${errorText(error)}`);
    }
  }
}

export const DISABLED_VAD_SNAPSHOT: VadSnapshot = {
  enabled: false,
  ready: false,
  mode: 'disabled',
  gate: 'open',
  probability: 0,
  isSpeech: false,
  level: 'off',
};

export const INITIAL_SILERO_VAD_SNAPSHOT: VadSnapshot = {
  enabled: true,
  ready: false,
  mode: 'silero',
  gate: 'closed',
  probability: 0,
  isSpeech: false,
  level: 'off',
};

export function resolveVadLevel(probability: number, isSpeech: boolean): VadLevel {
  if (!isSpeech) return 'off';
  if (probability >= 0.85) return 'veryStrong';
  if (probability >= 0.65) return 'strong';
  if (probability >= 0.5) return 'medium';
  return 'weak';
}

export class SampleBasedVadGate {
  private gate: 'open' | 'closed' = 'closed';
  private speechDetected = false;
  private silentSamples = 0;

  reset(): void {
    this.gate = 'closed';
    this.speechDetected = false;
    this.silentSamples = 0;
  }

  process(probability: number, rms: number, sampleStart: number, sampleCount: number): VadDecision {
    if (probability >= CLIENT_VAD_POLICY.positiveThreshold) this.speechDetected = true;
    else if (probability <= CLIENT_VAD_POLICY.negativeThreshold) this.speechDetected = false;

    if (this.speechDetected) this.silentSamples = 0;
    else if (this.gate === 'open') this.silentSamples += sampleCount;
    const shouldOpen = this.speechDetected
      || (this.gate === 'open' && this.silentSamples < CLIENT_VAD_POLICY.silenceSamples);
    const nextGate = shouldOpen ? 'open' : 'closed';
    const event: VadGateEvent | undefined = nextGate === this.gate
      ? undefined
      : nextGate === 'open' ? 'speech_gate_opened' : 'speech_gate_closed';
    this.gate = nextGate;

    return {
      enabled: true,
      ready: true,
      mode: 'silero',
      gate: this.gate,
      probability,
      rms,
      isSpeech: this.gate === 'open',
      level: resolveVadLevel(probability, this.gate === 'open'),
      ...(event ? { event } : {}),
    };
  }
}

/** Silero v6.2 recurrent runtime. The native module is loaded only when client VAD is enabled. */
export class SileroVadRuntime implements VadRuntime {
  private ort: typeof import('onnxruntime-react-native') | null = null;
  private session: import('onnxruntime-react-native').InferenceSession | null = null;
  private state = new Float32Array(CLIENT_VAD_POLICY.stateSize);
  private context = new Float32Array(CLIENT_VAD_POLICY.contextSamples);
  private pending = new Float32Array(0);
  private probability = 0;
  private readonly errorBudget = new ConsecutiveVadErrorBudget();
  private resetGeneration = 0;

  async initialize(): Promise<void> {
    if (this.session) return;
    const asset = Asset.fromModule(require('../../assets/models/silero_vad_v6.2.onnx'));
    await asset.downloadAsync();
    const modelUri = asset.localUri ?? asset.uri;
    if (!modelUri) throw new Error('Unable to prepare the Silero VAD model file.');

    const ort = await import('onnxruntime-react-native');
    const session = await ort.InferenceSession.create(modelUri, {
      executionMode: 'sequential',
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
      interOpNumThreads: 1,
      intraOpNumThreads: 1,
    });
    this.ort = ort;
    this.session = session;
    this.reset();
    await this.runInference(new Float32Array(CLIENT_VAD_POLICY.inferenceFrameSamples), this.resetGeneration);
  }

  async process(samples: Float32Array): Promise<number> {
    if (!this.session || !this.ort) throw new Error('Silero VAD is not initialized.');
    const generation = this.resetGeneration;
    const combined = new Float32Array(this.pending.length + samples.length);
    combined.set(this.pending);
    combined.set(samples, this.pending.length);
    let offset = 0;
    while (offset + CLIENT_VAD_POLICY.inferenceFrameSamples <= combined.length) {
      const frame = combined.slice(offset, offset + CLIENT_VAD_POLICY.inferenceFrameSamples);
      try {
        const probability = await this.runInference(frame, generation);
        if (generation !== this.resetGeneration) return 0;
        this.probability = probability;
        this.errorBudget.success();
      } catch (error) {
        this.probability = 0;
        this.errorBudget.failure(error);
      }
      offset += CLIENT_VAD_POLICY.inferenceFrameSamples;
    }
    if (generation !== this.resetGeneration) return 0;
    this.pending = combined.slice(offset);
    return this.probability;
  }

  reset(): void {
    this.resetGeneration += 1;
    this.state = new Float32Array(CLIENT_VAD_POLICY.stateSize);
    this.context = new Float32Array(CLIENT_VAD_POLICY.contextSamples);
    this.pending = new Float32Array(0);
    this.probability = 0;
    this.errorBudget.reset();
  }

  async dispose(): Promise<void> {
    this.reset();
    const session = this.session;
    this.session = null;
    this.ort = null;
    if (session) await session.release();
  }

  private async runInference(frame: Float32Array, generation: number): Promise<number> {
    const session = this.session;
    const ort = this.ort;
    if (!session || !ort) throw new Error('Silero VAD is not initialized.');
    const input = new Float32Array(CLIENT_VAD_POLICY.contextSamples + frame.length);
    input.set(this.context);
    input.set(frame, CLIENT_VAD_POLICY.contextSamples);
    const output = await session.run({
      input: new ort.Tensor('float32', input, [1, input.length]),
      state: new ort.Tensor('float32', this.state.slice(), [2, 1, 128]),
      sr: new ort.Tensor('int64', new BigInt64Array([BigInt(CLIENT_VAD_POLICY.sampleRate)]), []),
    });
    if (generation !== this.resetGeneration) return 0;
    const probability = Number(output.output?.data[0]);
    const nextState = output.stateN?.data;
    if (!Number.isFinite(probability) || !(nextState instanceof Float32Array) || nextState.length !== CLIENT_VAD_POLICY.stateSize) {
      throw new Error('Invalid Silero VAD model output.');
    }
    this.context = frame.slice(frame.length - CLIENT_VAD_POLICY.contextSamples);
    this.state = nextState.slice();
    return Math.max(0, Math.min(1, probability));
  }
}

export interface ClientVadPipelineHandlers {
  onOutput(frame: PcmAudioFrame, decision: VadDecision, sampleStart: number): void;
  onDecision(decision: VadDecision): void;
  onFatal(error: Error): void;
}

/** A single async FIFO keeps inference, boundary status, and PCM ordering deterministic. */
export class ClientVadPipeline {
  private readonly gate = new SampleBasedVadGate();
  private tail: Promise<void> = Promise.resolve();
  private epoch = 0;
  private nextSample = 0;
  private pendingFrames = 0;
  private failed = false;

  constructor(private readonly runtime: VadRuntime, private readonly handlers: ClientVadPipelineHandlers) {}

  reset(sampleStart = 0, resetRuntime = true): void {
    this.epoch += 1;
    this.nextSample = sampleStart;
    this.pendingFrames = 0;
    this.failed = false;
    this.gate.reset();
    if (resetRuntime) this.runtime.reset();
  }

  enqueue(frame: PcmAudioFrame): void {
    if (this.failed) return;
    if (this.pendingFrames >= CLIENT_VAD_POLICY.maxPendingFrames) {
      this.failed = true;
      this.handlers.onFatal(new Error('Silero VAD processing queue exceeded the latency limit.'));
      return;
    }
    const epoch = this.epoch;
    const sampleStart = this.nextSample;
    this.nextSample += frame.sampleCount;
    this.pendingFrames += 1;
    this.tail = this.tail.then(async () => {
      if (epoch !== this.epoch || this.failed) return;
      const probability = await this.runtime.process(frame.samples);
      if (epoch !== this.epoch || this.failed) return;
      const decision = this.gate.process(probability, calculateRms(frame.samples), sampleStart, frame.sampleCount);
      this.handlers.onDecision(decision);
      if (epoch !== this.epoch || this.failed) return;
      this.handlers.onOutput(frame, decision, sampleStart);
    }).catch((error) => {
      if (epoch !== this.epoch || this.failed) return;
      this.failed = true;
      this.handlers.onFatal(error instanceof Error ? error : new Error(String(error)));
    }).finally(() => {
      if (epoch === this.epoch) this.pendingFrames = Math.max(0, this.pendingFrames - 1);
    });
  }

  async drain(): Promise<void> {
    await this.tail;
  }
}

export function calculateRms(samples: Float32Array): number {
  // Observability only: Silero probability is the sole gate input.
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
