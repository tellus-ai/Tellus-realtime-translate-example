import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// 실제 앱의 공개 SDK를 검사한다. 마이크 payload는 저장·송신하지 않는다.
const mobileRoot = fileURLToPath(new URL('..', import.meta.url));
const [engineRoot, modelDir, keyFile] = process.argv.slice(2).map(value => resolve(value));
if (!engineRoot || !modelDir || !keyFile || process.env.TELLUS_ENGINE_TEST_LICENSE !== '1') {
  throw new Error('Usage: TELLUS_ENGINE_TEST_LICENSE=1 node scripts/native-sdk-probe.mjs ENGINE_ROOT MODEL_DIR TEST_KEY_FILE');
}
const metro = process.env.METRO_URL ?? 'http://localhost:8088';
const appId = 'com.tellus.realtimetranslationexample';
const { startEngineTestServer } = await import(pathToFileURL(resolve(mobileRoot, '../web/scripts/test-engine-server.mjs')));
const { signTestPermit } = createRequire(import.meta.url)(resolve(engineRoot, 'scripts/ci/engine-authorization-fixture.js'));
const fixture = await startEngineTestServer({ engineRoot, modelDir, keyFile, staticRoot: mobileRoot,
  probeHtml: resolve(mobileRoot, 'README.md'), stereoWav: resolve(mobileRoot, 'README.md') });
let socket;
let nextId = 0;
const pending = new Map();
const delay = ms => new Promise(done => setTimeout(done, ms));

function wav(seconds) {
  const frames = 16000 * seconds;
  const bytes = Buffer.alloc(44 + frames * 2);
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(frames * 2, 40);
  return bytes.toString('base64');
}

function runtimeProbe(url, shortWav, longWav) {
  var state = globalThis.__tellusNativeProbe = { phase: 'starting', chunks: 0, errors: [], results: [] };
  function requireModule(pattern) {
    var found = Array.from(globalThis.__r.getModules()).find(function (entry) { return pattern.test(entry[1].verboseName); });
    if (!found) throw new Error('SDK module unavailable');
    return globalThis.__r(found[0]);
  }
  var AudioEngine = requireModule(/runtime\/platforms\/mobile\/react-native\/index\.js$/).AudioEngine;
  var attach = requireModule(/runtime\/bindings\/typescript\/authorization\/realtime\.js$/).attachEngineAuthorization;
  var delay = function (ms) { return new Promise(function (done) { setTimeout(done, ms); }); };
  function check(value, message) { if (!value) throw new Error(message); state.results.push(message); }
  function encoded(base64) {
    var text = atob(base64), bytes = new Uint8Array(text.length);
    for (var i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
    return bytes.buffer;
  }
  function callback(error, chunk) {
    if (error) { state.errors.push(error.message); return; }
    if (chunk) {
      state.chunks++;
      state.metadata = { codec: chunk.codec, sampleRate: chunk.sampleRate, validSampleCount: chunk.validSampleCount,
        sampleCount: chunk.sampleCount, bytes: chunk.data.microphone.byteLength };
    }
  }
  function authorize() {
    state.socket = new WebSocket(url.replace('http:', 'ws:') + '/audio?conversation_id=conversation-1');
    state.controller = attach(state.socket, state.capture, { conversationId: 'conversation-1', getAccessToken: function () { return 'test-access-token'; },
      requestTimeoutMs: 30000, onError: function (error) { state.errors.push(error.message); } });
    return state.controller.ready;
  }
  function makeCapture(vad) {
    return AudioEngine.init({ vadEnabled: vad, denoiseEnabled: true, echoCancellationEnabled: true,
      processing: { sampleRate: 16000, chunkDurationMs: 20 }, transport: { codec: 'opus', bitrateBps: 64000 } })
      .then(function (engine) { state.capture = engine.createCapture(); });
  }
  makeCapture(false)
    .then(function () { return state.capture.start(callback).then(function () { throw new Error('Unapproved start succeeded'); }, function (error) {
      check(/authorization/.test(error.message), 'unapproved start blocked'); }); })
    .then(authorize).then(function () { return state.capture.start(callback); }).then(function () { return delay(400); })
    .then(function () { check(state.chunks > 0 && state.metadata.codec === 'opus' && state.metadata.sampleRate === 16000 && state.metadata.validSampleCount === 320, 'native microphone metadata');
      return state.capture.playbackEncoded(encoded(shortWav)); })
    .then(function () { check(true, 'synthetic WAV completion');
      var playback = state.capture.playbackEncoded(encoded(longWav)).then(function () { throw new Error('Cancelled playback completed'); }, function (error) {
        check(/cancel/.test(error.message), 'synthetic WAV cancellation'); });
      return delay(80).then(function () { return state.capture.cancelPlayback(); }).then(function () { return playback; }); })
    .then(function () { return state.capture.pause(); }).then(function () { var count = state.chunks; return delay(150).then(function () { check(state.chunks === count, 'pause stops delivery'); }); })
    .then(function () { return state.capture.resume(); }).then(function () { return state.capture.reset(); })
    .then(function () { return state.capture.setDenoiseEnabled(false); }).then(function () { return state.capture.setDenoiseEnabled(true); })
    .then(function () { state.controller.dispose(); state.socket.close(); var count = state.chunks;
      return delay(150).then(function () { check(state.chunks === count, 'revocation stops delivery'); }); })
    .then(authorize).then(function () { return state.capture.resume(); }).then(function () { return delay(150); })
    .then(function () { return state.capture.stop(); }).then(function () { return state.capture.start(callback); })
    .then(function () { return delay(150); }).then(function () { return state.capture.stop(); })
    .then(function () { check(state.errors.length === 0, 'same capture reconnect and restart'); state.controller.dispose(); state.socket.close(); return state.capture.dispose(); })
    .then(function () { return makeCapture(true); }).then(authorize)
    .then(function () { return state.capture.getStatus(); }).then(function (status) { check(status.modelsLoaded.length === 2 && status.modelsLoaded.indexOf('silero-vad') >= 0, 'encrypted FE and VAD loaded');
      return state.capture.setRecordingNotification({ title: 'Tellus SDK test', contentText: 'Metadata only', onPause: function () {}, onResume: function () {} }); })
    .then(function () { return state.capture.start(callback); }).then(function () { return delay(300); })
    .then(function () { return state.capture.pause(); }).then(function () { state.controller.dispose(); state.socket.close();
      return state.capture.createAuthorizationRequest('conversation-1'); })
    .then(function (request) { state.request = request; state.phase = 'expiry_request'; })
    .catch(function (error) { state.failure = error.message; state.phase = 'failed'; });
  return 'started';
}

async function command(method, params = {}) {
  const id = ++nextId;
  const result = new Promise((done, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, value => { clearTimeout(timer); value.error ? reject(new Error(value.error.message)) : done(value.result); });
  });
  socket.send(JSON.stringify({ id, method, params }));
  return result;
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}
async function waitPhase(phase) {
  for (let attempt = 0; attempt < 300; attempt++) {
    const state = JSON.parse(await evaluate('JSON.stringify({phase:globalThis.__tellusNativeProbe.phase,failure:globalThis.__tellusNativeProbe.failure})'));
    if (state.phase === 'failed') throw new Error(state.failure);
    if (state.phase === phase) return;
    await delay(200);
  }
  throw new Error(`Native probe timeout: ${phase}`);
}

try {
  let page;
  for (let attempt = 0; attempt < 150 && !page; attempt++) {
    const pages = await fetch(`${metro}/json/list`).then(response => response.json()).catch(() => []);
    page = pages.find(candidate => candidate.appId === appId);
    if (!page) await delay(200);
  }
  assert(page, 'Development app inspector unavailable');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((done, reject) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', event => { const value = JSON.parse(event.data); if (pending.has(value.id)) { pending.get(value.id)(value); pending.delete(value.id); } });
  await command('Runtime.enable');
  if (process.env.ANDROID_SERIAL) {
    const { execFileSync } = await import('node:child_process');
    execFileSync('adb', ['-s', process.env.ANDROID_SERIAL, 'reverse', `tcp:${new URL(fixture.url).port}`, `tcp:${new URL(fixture.url).port}`]);
  }
  await evaluate(`(${runtimeProbe.toString()})(${JSON.stringify(fixture.url)},${JSON.stringify(wav(0.2))},${JSON.stringify(wav(4))})`);
  await waitPhase('expiry_request');
  const request = JSON.parse(await evaluate('JSON.stringify(globalThis.__tellusNativeProbe.request)'));
  const permit = signTestPermit(request, { ttlMs: 8000, conversationId: 'conversation-1' });
  await evaluate(`globalThis.__tellusNativeProbe.capture.applyAuthorization(${JSON.stringify(permit)}).then(function(){return globalThis.__tellusNativeProbe.capture.resume();}).then(function(){return globalThis.__tellusNativeProbe.capture.pause();}).then(function(){globalThis.__tellusNativeProbe.phase='paused_expiry';}).catch(function(error){globalThis.__tellusNativeProbe.failure=error.message;globalThis.__tellusNativeProbe.phase='failed';}); 'started'`);
  await waitPhase('paused_expiry');
  await delay(9500);
  const status = JSON.parse(await evaluate('globalThis.__tellusNativeProbe.capture.getAuthorizationStatus().then(function(status){globalThis.__tellusNativeProbe.authorization=status;}); JSON.stringify(globalThis.__tellusNativeProbe.authorization || {})'));
  if (!status.state) await delay(100);
  const authorization = JSON.parse(await evaluate('JSON.stringify(globalThis.__tellusNativeProbe.authorization)'));
  assert.equal(authorization.state, 'expired');
  const summary = JSON.parse(await evaluate('JSON.stringify({chunks:globalThis.__tellusNativeProbe.chunks,metadata:globalThis.__tellusNativeProbe.metadata,results:globalThis.__tellusNativeProbe.results,errors:globalThis.__tellusNativeProbe.errors})'));
  assert.deepEqual(summary.errors, ['engine_authorization_expired']);
  assert.equal(fixture.stats.frames, 0, 'Microphone payload must never leave the device');
  assert.equal(fixture.stats.errors.length, 0);
  if (process.env.ANDROID_SERIAL) {
    const { execFileSync } = await import('node:child_process');
    const services = execFileSync('adb', ['-s', process.env.ANDROID_SERIAL, 'shell', 'dumpsys', 'activity', 'services', appId], { encoding: 'utf8' });
    assert(!/ServiceRecord[^\n]*TellusMicrophoneService/.test(services), 'Expired paused foreground-service lease remained active');
  }
  await evaluate("globalThis.__tellusNativeProbe.capture.dispose().then(function(){globalThis.__tellusNativeProbe.phase='disposed';}); 'started'");
  await waitPhase('disposed');
  console.log(JSON.stringify({ ...summary, pausedExpiry: true, microphonePayloadsSent: fixture.stats.frames }));
} finally {
  if (socket?.readyState === WebSocket.OPEN) {
    await evaluate("if(globalThis.__tellusNativeProbe){globalThis.__tellusNativeProbe.controller?.dispose();globalThis.__tellusNativeProbe.socket?.close();globalThis.__tellusNativeProbe.capture?.dispose();} 'cleanup'").catch(() => {});
  }
  socket?.close();
  await fixture.close();
}
