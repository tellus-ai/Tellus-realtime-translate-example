const { createHash } = require('crypto');
const { readFileSync } = require('fs');
const { join } = require('path');

const expected = '1a153a22f4509e292a94e67d6f9b85e8deb25b4988682b7e174c65279d8788e3';
const modelPath = join(__dirname, '..', 'assets', 'models', 'silero_vad_v6.2.onnx');
const actual = createHash('sha256').update(readFileSync(modelPath)).digest('hex');

if (actual !== expected) {
  throw new Error(`Silero VAD model checksum mismatch: expected ${expected}, received ${actual}`);
}

console.log(`Silero VAD model checksum OK: ${actual}`);
