import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const sourceRoot = new URL('../node_modules/onnxruntime-web/dist/', import.meta.url);
const outputRoot = new URL('../public/ort/', import.meta.url);
const assets = [
  'ort-wasm-simd-threaded.mjs',
  'ort-wasm-simd-threaded.wasm',
];

await mkdir(fileURLToPath(outputRoot), { recursive: true });
for (const asset of assets) {
  await copyFile(new URL(asset, sourceRoot), new URL(asset, outputRoot));
}

console.log(`Synced ${assets.length} ONNX Runtime assets into ${projectRoot}public/ort/.`);
