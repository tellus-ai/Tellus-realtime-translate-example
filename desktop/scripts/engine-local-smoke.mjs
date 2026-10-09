import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
assert.ok(args.length === 0 || (args.length === 1 && args[0] === '--mic'), 'Expected only --mic');
const microphone = args[0] === '--mic';
const sdk = path.resolve(desktop, '../../tellus-audio-sdk');
const engineRoot = path.resolve(process.env.TELLUS_ENGINE_ROOT ?? path.resolve(desktop, '../../Tellus-audio-engine'));
const requireDesktop = createRequire(path.join(desktop, 'package.json'));
const sha = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
assert.equal(process.env.TELLUS_ENGINE_TEST_LICENSE, '1');
assert.equal(fs.realpathSync(requireDesktop.resolve('@tellus-ai/audio-sdk')), fs.realpathSync(path.join(sdk, 'dist/index.js')));
const nativeName = 'audio-capture.darwin-universal.node';
const nativeSha = sha(path.join(engineRoot, nativeName));
assert.equal(sha(path.join(sdk, 'vendor/darwin-universal', nativeName)), nativeSha);
const requireEngine = createRequire(path.join(engineRoot, 'package.json'));
const { signTestPermit } = requireEngine('./scripts/ci/engine-authorization-fixture');
const { AudioCapture } = requireDesktop('@tellus-ai/audio-sdk');
(async () => {
  let capture;
  if (microphone) {
    const engine = await requireDesktop('./dist/electron/audio/audioEngine.js').initializeAudioEngine();
    assert.equal(engine.getStatus().vad.ready, true);
    capture = engine.createCapture();
  } else capture = new AudioCapture({ micEnabled: false, speakerEnabled: false, denoiseEnabled: false, vadEnabled: false });
  const chunks = [];
  const errors = [];
  capture.onError(error => errors.push(error));
  capture.setVadEnabled(false);
  const callback = (error, chunk) => {
    if (error) { errors.push(error); return; }
    chunks.push({ bytes: chunk.data.microphone?.length ?? 0, codec: chunk.codec,
      rate: chunk.sampleRate, rms: chunk.rms, sample: chunk.sample });
  };
  try {
    assert.throws(() => capture.start(callback), /engine_authorization_required/);
    assert.throws(() => capture.resume(), /engine_authorization_required/);
    capture.applyAuthorization(signTestPermit(capture.createAuthorizationRequest('ci-conversation')));
    if (!microphone) {
      assert.equal(capture.getAuthorizationStatus().state, 'authorized');
      assert.throws(() => capture.start(callback), /At least one of mic_enabled or speaker_enabled/);
      assert.equal(capture.getState(), 'idle');
      assert.equal(capture.getStatus().micThreadAlive, false);
      assert.equal(capture.getStatus().speakerThreadAlive, false);
      capture.stop();
      capture.invalidateAuthorization();
      assert.throws(() => capture.start(callback), /engine_authorization_required/);
      assert.throws(() => capture.resume(), /engine_authorization_required/);
      console.log(JSON.stringify({ nativeSha, microphone: false, localPermit: true, noInputRejectedBeforeDeviceAccess: true, revokedStartResumeBlocked: true, networkCalls: 0 }));
      return;
    }
    capture.start(callback);
    assert.equal(capture.getState(), 'recording');
    await delay(800);
    assert.ok(chunks.length >= 3, 'Actual native microphone chunks required');
    capture.pause();
    assert.equal(capture.getState(), 'paused');
    await delay(100);
    const paused = chunks.length;
    await delay(150);
    assert.equal(chunks.length, paused, 'Settled pause must suppress callbacks');
    capture.resume();
    assert.equal(capture.getState(), 'recording');
    await delay(400);
    assert.ok(chunks.length > paused, 'Resume must deliver new native chunks');
    capture.stop();
    assert.equal(capture.getState(), 'idle');
    await delay(100);
    const stopped = chunks.length;
    await delay(150);
    assert.equal(chunks.length, stopped, 'Stop must suppress callbacks');
    const status = capture.getStatus();
    assert.equal(status.micThreadAlive, false);
    assert.equal(status.mixerThreadAlive, false);
    capture.invalidateAuthorization();
    assert.throws(() => capture.start(callback), /engine_authorization_required/);
    assert.throws(() => capture.resume(), /engine_authorization_required/);
    assert.equal(errors.length, 0);
    assert.ok(chunks.every(chunk => chunk.bytes > 0 && chunk.codec === 'opus' && chunk.rate === 16000 && Number.isFinite(chunk.rms)));
    const maxRms = Math.max(0, ...chunks.map(chunk => chunk.rms));
    assert.ok(maxRms > 0, 'Actual microphone signal must be nonzero');
    console.log(JSON.stringify({ sdk: fs.realpathSync(requireDesktop.resolve('@tellus-ai/audio-sdk')), nativeSha,
      microphone, sileroPreloaded: microphone, chunks: chunks.length, bytes: chunks.reduce((total, chunk) => total + chunk.bytes, 0),
      maxRms, pauseResumeStop: true, revokedStartResumeBlocked: true, networkCalls: 0 }));
  } finally { capture.stop(); capture.invalidateAuthorization(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
