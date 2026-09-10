import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const expectedSha256 = '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3';
const modelUrl = new URL('../public/models/silero_vad_v6.2.1.onnx', import.meta.url);
const digest = createHash('sha256').update(await readFile(modelUrl)).digest('hex');

if (digest !== expectedSha256) {
  throw new Error(`Silero VAD model SHA-256 mismatch: expected ${expectedSha256}, received ${digest}`);
}

console.log(`Verified Silero VAD v6.2.1 model SHA-256: ${digest}`);
