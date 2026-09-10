import type {
  OpusEncoderWorkerRequest,
  OpusEncoderWorkerRequestBody,
  OpusEncoderWorkerResponse,
} from './OpusEncoderWorkerMessages';

export interface RealtimeAudioEncoder {
  initialize(): Promise<void>;
  encode(pcm16: ArrayBuffer): Promise<ArrayBuffer>;
  reset(): Promise<void>;
  dispose(): Promise<void>;
}

interface PendingRequest {
  resolve: (value: OpusEncoderWorkerResponse) => void;
  reject: (reason: Error) => void;
}

export class OpusEncoderWorkerClient implements RealtimeAudioEncoder {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private requestId = 0;
  private disposed = false;
  private failure: Error | null = null;

  constructor() {
    this.worker = new Worker(new URL('./OpusEncoderWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (event: MessageEvent<OpusEncoderWorkerResponse>) => this.handleMessage(event.data);
    this.worker.onerror = (event) => this.markFailed(new Error(event.message || 'Opus encoder Worker error'));
    this.worker.onmessageerror = () => this.markFailed(new Error('Unable to read the Opus encoder Worker message.'));
  }

  async initialize(): Promise<void> {
    const response = await this.request({ type: 'initialize' });
    if (response.type !== 'ready') throw new Error('Invalid Opus encoder initialization response.');
  }

  async encode(pcm16: ArrayBuffer): Promise<ArrayBuffer> {
    const input = pcm16.slice(0);
    const response = await this.request({ type: 'encode', pcm16: input }, [input]);
    if (response.type !== 'encoded') throw new Error('Invalid Opus encoder response.');
    return response.payload;
  }

  async reset(): Promise<void> {
    const response = await this.request({ type: 'reset' });
    if (response.type !== 'reset') throw new Error('Invalid Opus encoder reset response.');
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    this.rejectAll(new Error('Opus encoder Worker has terminated.'));
    this.worker.terminate();
  }

  private request(
    body: OpusEncoderWorkerRequestBody,
    transfer: Transferable[] = [],
  ): Promise<OpusEncoderWorkerResponse> {
    if (this.disposed) return Promise.reject(new Error('Opus encoder Worker has already terminated.'));
    if (this.failure) return Promise.reject(this.failure);
    const id = ++this.requestId;
    const request = { ...body, id } as OpusEncoderWorkerRequest;
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

  private handleMessage(response: OpusEncoderWorkerResponse): void {
    if (response.type === 'error') {
      const error = new Error(response.message);
      if (response.id !== null) {
        this.pending.get(response.id)?.reject(error);
        this.pending.delete(response.id);
      }
      this.markFailed(error);
      return;
    }

    const pending = this.pending.get(response.id);
    if (!pending) return;
    this.pending.delete(response.id);
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
