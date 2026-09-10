import type { OpusEncoderWorkerRequest, OpusEncoderWorkerResponse } from './OpusEncoderWorkerMessages';
import { WorkerOpusEncoder } from './WorkerOpusEncoder';

const OPUS_BITRATE_BPS = 64_000;
const OPUS_FRAME_DURATION_MS = 20;
const OPUS_SAMPLE_RATE = 16_000;

interface WorkerScope {
  onmessage: ((event: MessageEvent<OpusEncoderWorkerRequest>) => void) | null;
  postMessage(message: OpusEncoderWorkerResponse, transfer?: Transferable[]): void;
}

const workerScope = self as unknown as WorkerScope;
const pendingEncodeRequests: number[] = [];
let encoder: WorkerOpusEncoder | null = null;

workerScope.onmessage = (event) => {
  const request = event.data;
  try {
    if (request.type === 'initialize') {
      initializeEncoder();
      post({ id: request.id, type: 'ready' });
      return;
    }

    if (request.type === 'reset') {
      if (pendingEncodeRequests.length > 0) {
        throw new Error('[AudioWorker] Cannot reset with pending Opus frames.');
      }
      initializeEncoder();
      post({ id: request.id, type: 'reset' });
      return;
    }

    if (!encoder) throw new Error('[AudioWorker] Opus encoder is not initialized.');
    pendingEncodeRequests.push(request.id);
    try {
      encoder.encode(new Int16Array(request.pcm16));
    } catch (error) {
      pendingEncodeRequests.pop();
      throw error;
    }
  } catch (error) {
    postError(request.id, error);
  }
};

function initializeEncoder(): void {
  encoder?.close();
  encoder = new WorkerOpusEncoder({
    bitrateBps: OPUS_BITRATE_BPS,
    frameDurationMs: OPUS_FRAME_DURATION_MS,
    sampleRate: OPUS_SAMPLE_RATE,
    onEncodedData: (payload) => {
      const id = pendingEncodeRequests.shift();
      if (id === undefined) {
        postError(null, new Error('[AudioWorker] Received an unexpected Opus output frame.'));
        return;
      }
      post({ id, type: 'encoded', payload }, [payload]);
    },
    onError: (error) => postError(pendingEncodeRequests.shift() ?? null, error),
  });
  encoder.initialize();
}

function post(response: OpusEncoderWorkerResponse, transfer: Transferable[] = []): void {
  workerScope.postMessage(response, transfer);
}

function postError(id: number | null, error: unknown): void {
  post({
    id,
    type: 'error',
    fatal: true,
    message: error instanceof Error ? error.message : String(error),
  });
}
