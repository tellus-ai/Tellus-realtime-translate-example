import type { BrowserEngineAssets } from '@tellus-ai/audio-sdk-web';

/** 공개 런타임·암호화 모델 URL만 지정한다. 모델 키는 /audio 승인으로 받는다. */
export function browserEngineAssets(clientVad: boolean): BrowserEngineAssets {
  const base = new URL(import.meta.env.VITE_TELLUS_AUDIO_ASSET_BASE ?? 'tellus-audio/', document.baseURI);
  return {
    engineModuleUrl: new URL('tellus-audio-engine.mjs', base).href,
    wasmUrl: new URL('tellus-audio-engine.wasm', base).href,
    ortModuleUrl: new URL('ort/ort.wasm.bundle.min.mjs', base).href,
    ortWasmBaseUrl: new URL('ort/', base).href,
    encryptedModels: [
      new URL('models/fe-s16.temc', base).href,
      ...(clientVad ? [new URL('models/silero-vad.temc', base).href] : []),
    ],
  };
}
