export type OpusEncoderWorkerRequestBody =
  | { type: 'initialize' }
  | { type: 'encode'; pcm16: ArrayBuffer }
  | { type: 'reset' };

export type OpusEncoderWorkerRequest = OpusEncoderWorkerRequestBody & { id: number };

export type OpusEncoderWorkerResponse =
  | { id: number; type: 'ready' }
  | { id: number; type: 'encoded'; payload: ArrayBuffer }
  | { id: number; type: 'reset' }
  | { id: number | null; type: 'error'; message: string; fatal: true };
