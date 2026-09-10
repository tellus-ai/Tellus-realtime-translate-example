// Keep the upstream model artifact name so its provenance and checksum remain obvious.
export const SILERO_VAD_MODEL_PATH = 'models/silero_vad_v6.2.1.onnx';
export const SILERO_VAD_MODEL_SHA256 = '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3';
export const ORT_WASM_PATH = 'ort/';

export const VAD_SAMPLE_RATE = 16_000;
export const VAD_INFERENCE_SAMPLES = 512;
export const VAD_CONTEXT_SAMPLES = 64;
export const VAD_STATE_SIZE = 2 * 1 * 128;
export const VAD_POSITIVE_THRESHOLD = 0.5;
export const VAD_NEGATIVE_THRESHOLD = 0.35;
export const VAD_MIN_SILENCE_SAMPLES = Math.round(VAD_SAMPLE_RATE * 0.55);
export const VAD_MAX_CONSECUTIVE_ERRORS = 8;
