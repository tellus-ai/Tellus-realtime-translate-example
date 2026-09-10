import * as ort from 'onnxruntime-web/wasm';
import {
  VAD_CONTEXT_SAMPLES,
  VAD_INFERENCE_SAMPLES,
  VAD_MAX_CONSECUTIVE_ERRORS,
  VAD_SAMPLE_RATE,
  VAD_STATE_SIZE,
} from './VADConfig';
import { VADSileroGate } from './VADSileroGate';
import type { VadDecision, VadWorkerRequest, VadWorkerResponse } from './VADTypes';

interface WorkerScope {
  onmessage: ((event: MessageEvent<VadWorkerRequest>) => void) | null;
  postMessage(message: VadWorkerResponse): void;
}

const workerScope = self as unknown as WorkerScope;
const gate = new VADSileroGate();
let session: ort.InferenceSession | null = null;
let recurrentState = createInitialState();
let context = new Float32Array(VAD_CONTEXT_SAMPLES);
let pendingSamples = new Float32Array(0);
let lastProbability = 0;
let consecutiveErrors = 0;
let activeGeneration = 0;
let queue = Promise.resolve();

ort.env.wasm.numThreads = 1;
ort.env.wasm.proxy = false;

workerScope.onmessage = (event) => {
  const request = event.data;
  queue = queue.then(() => handleRequest(request)).catch((error) => {
    postError(request, error, true);
  });
};

async function handleRequest(request: VadWorkerRequest): Promise<void> {
  if (request.type === 'initialize') {
    activeGeneration = request.generation;
    ort.env.wasm.wasmPaths = request.wasmBaseUrl;
    session ??= await ort.InferenceSession.create(request.modelUrl, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    });
    await resetAndWarmUp();
    post({ id: request.id, generation: request.generation, type: 'ready' });
    return;
  }

  if (request.type === 'dispose') {
    if (session) await session.release();
    session = null;
    resetState();
    post({ id: request.id, generation: request.generation, type: 'disposed' });
    return;
  }

  if (request.generation < activeGeneration) return;
  if (request.generation > activeGeneration) {
    activeGeneration = request.generation;
    resetState();
  }

  if (request.type === 'reset') {
    activeGeneration = request.generation;
    await resetAndWarmUp();
    post({ id: request.id, generation: request.generation, type: 'reset' });
    return;
  }

  if (!session) {
    postError(request, new Error('Silero VAD model is not ready.'), true);
    return;
  }

  const samples = new Float32Array(request.samples);
  appendPending(samples);
  try {
    while (pendingSamples.length >= VAD_INFERENCE_SAMPLES) {
      const inferenceFrame = pendingSamples.slice(0, VAD_INFERENCE_SAMPLES);
      pendingSamples = pendingSamples.slice(VAD_INFERENCE_SAMPLES);
      lastProbability = await infer(inferenceFrame);
      consecutiveErrors = 0;
    }
  } catch (error) {
    consecutiveErrors += 1;
    lastProbability = 0;
    if (consecutiveErrors >= VAD_MAX_CONSECUTIVE_ERRORS) {
      postError(request, new Error(`Silero VAD inference failed ${VAD_MAX_CONSECUTIVE_ERRORS} consecutive times.`), true);
      return;
    }
  }

  const decision: VadDecision = gate.process(lastProbability, request.sampleStart, samples.length);
  post({ id: request.id, generation: request.generation, type: 'decision', decision });
}

async function infer(frame: Float32Array): Promise<number> {
  if (!session) throw new Error('Silero VAD session is unavailable.');
  const input = new Float32Array(VAD_CONTEXT_SAMPLES + VAD_INFERENCE_SAMPLES);
  input.set(context);
  input.set(frame, VAD_CONTEXT_SAMPLES);
  const outputs = await session.run({
    input: new ort.Tensor('float32', input, [1, input.length]),
    state: recurrentState,
    sr: new ort.Tensor('int64', BigInt64Array.of(BigInt(VAD_SAMPLE_RATE)), []),
  });
  const probabilityTensor = outputs.output ?? outputs[session.outputNames[0]];
  const nextState = outputs.stateN ?? outputs[session.outputNames[1]];
  if (!probabilityTensor || !nextState) throw new Error('Invalid Silero VAD output.');
  recurrentState = nextState;
  context = frame.slice(VAD_INFERENCE_SAMPLES - VAD_CONTEXT_SAMPLES);
  return Number(probabilityTensor.data[0] ?? 0);
}

function appendPending(samples: Float32Array): void {
  const next = new Float32Array(pendingSamples.length + samples.length);
  next.set(pendingSamples);
  next.set(samples, pendingSamples.length);
  pendingSamples = next;
}

function createInitialState(): ort.Tensor {
  return new ort.Tensor('float32', new Float32Array(VAD_STATE_SIZE), [2, 1, 128]);
}

function resetState(): void {
  recurrentState = createInitialState();
  context = new Float32Array(VAD_CONTEXT_SAMPLES);
  pendingSamples = new Float32Array(0);
  lastProbability = 0;
  consecutiveErrors = 0;
  gate.reset();
}

async function resetAndWarmUp(): Promise<void> {
  resetState();
  await infer(new Float32Array(VAD_INFERENCE_SAMPLES));
}

function post(response: VadWorkerResponse): void {
  workerScope.postMessage(response);
}

function postError(request: VadWorkerRequest, error: unknown, fatal: boolean): void {
  post({
    id: request.id,
    generation: request.generation,
    type: 'error',
    fatal,
    message: error instanceof Error ? error.message : String(error),
  });
}
