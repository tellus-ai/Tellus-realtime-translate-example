import type {
  ClientVadProcessor,
  VadDecision,
  VadProcessInput,
  VadWorkerRequestBody,
  VadWorkerRequest,
  VadWorkerResponse,
} from './VADTypes';
import { ORT_WASM_PATH, SILERO_VAD_MODEL_PATH } from './VADConfig';

interface PendingRequest {
  resolve: (value: VadWorkerResponse) => void;
  reject: (reason: Error) => void;
}

export class VADSileroWorkerClient implements ClientVadProcessor {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private requestId = 0;
  private generation = 0;
  private disposed = false;
  private failure: Error | null = null;

  constructor() {
    this.worker = new Worker(new URL('./VADSileroWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<VadWorkerResponse>) => this.handleMessage(event.data);
    this.worker.onerror = (event) => this.markFailed(new Error(event.message || 'Silero VAD Worker error'));
    this.worker.onmessageerror = () => this.markFailed(new Error('Unable to read the Silero VAD Worker message.'));
  }

  async initialize(): Promise<void> {
    const publicBaseUrl = new URL(import.meta.env.BASE_URL, window.location.origin);
    await this.request({
      type: 'initialize',
      modelUrl: new URL(SILERO_VAD_MODEL_PATH, publicBaseUrl).href,
      wasmBaseUrl: new URL(ORT_WASM_PATH, publicBaseUrl).href,
    });
  }

  async reset(): Promise<void> {
    this.generation += 1;
    await this.request({ type: 'reset' });
  }

  async process(input: VadProcessInput): Promise<VadDecision> {
    const samples = input.samples.slice();
    const response = await this.request(
      { type: 'process', sampleStart: input.sampleStart, samples: samples.buffer },
      [samples.buffer],
    );
    if (response.type !== 'decision') throw new Error('Invalid Silero VAD response.');
    return response.decision;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    // terminate() also releases the Worker-owned ORT session and cannot hang after a worker crash.
    this.rejectAll(new Error('Silero VAD Worker has terminated.'));
    this.worker.terminate();
  }

  private request(
    body: VadWorkerRequestBody,
    transfer: Transferable[] = [],
  ): Promise<VadWorkerResponse> {
    if (this.disposed) return Promise.reject(new Error('Silero VAD Worker has already terminated.'));
    if (this.failure) return Promise.reject(this.failure);
    return this.requestInternal(body, transfer);
  }

  private requestInternal(
    body: VadWorkerRequestBody,
    transfer: Transferable[] = [],
  ): Promise<VadWorkerResponse> {
    const id = ++this.requestId;
    const request = { ...body, id, generation: this.generation } as VadWorkerRequest;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.worker.postMessage(request, transfer);
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private handleMessage(response: VadWorkerResponse): void {
    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
    if (response.type === 'error') {
      const error = new Error(response.message);
      pending.reject(error);
      if (response.fatal) this.markFailed(error);
      return;
    }
    pending.resolve(response);
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private markFailed(error: Error): void {
    this.failure = error;
    this.rejectAll(error);
  }
}
