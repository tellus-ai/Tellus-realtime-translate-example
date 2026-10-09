import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';
import { chromium } from 'playwright';
import { startEngineTestServer } from './test-engine-server.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const engineRoot = resolve(process.env.TELLUS_ENGINE_ROOT ?? resolve(root, '../../Tellus-audio-engine'));
const keyFile = process.env.TELLUS_TEST_MODEL_KEY_FILE;
if (!keyFile) throw new Error('Set TELLUS_TEST_MODEL_KEY_FILE to the key used for the test-only TEMC assets');
const temporary = mkdtempSync(resolve(tmpdir(), 'tellus-web-engine-e2e-'));
const staticRoot = resolve(temporary, 'dist');
const stereoWav = resolve(temporary, 'stereo.wav');

function wav(samples, channels) {
  const bytes = Buffer.alloc(44 + samples.length * 2);
  bytes.write('RIFF', 0); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(channels, 22);
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000 * channels, 28);
  bytes.writeUInt16LE(2 * channels, 32); bytes.writeUInt16LE(16, 34); bytes.write('data', 36); bytes.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((sample, i) => bytes.writeInt16LE(sample, 44 + i * 2));
  return bytes;
}
writeFileSync(stereoWav, wav(Array.from({ length: 6400 }, (_, i) => Math.round(3000 * Math.sin(i * Math.PI * 2 * 220 / 32000))), 2));
const recorded = readFileSync(resolve(engineRoot, 'test_data/recorded/audio/korean/korea_1m_2people_meeting.wav'));
let offset = 12;
while (recorded.toString('ascii', offset, offset + 4) !== 'data') offset += 8 + recorded.readUInt32LE(offset + 4) + (recorded.readUInt32LE(offset + 4) % 2);
const speech = Array.from({ length: 16000 * 10 }, (_, i) => i < 16000 * 6 ? recorded.readInt16LE(offset + 8 + i * 2) : 0);
const microphoneWav = resolve(temporary, 'microphone.wav');
writeFileSync(microphoneWav, wav(speech, 1));
const server = await startEngineTestServer({ engineRoot, keyFile, modelDir: resolve(root, 'public/tellus-audio/models'), staticRoot, probeHtml: resolve(root, 'scripts/browser-sdk-probe.html'), stereoWav });
let browser, page;
const sampleRate = Number(process.env.TELLUS_TEST_SAMPLE_RATE ?? 16000);
assert.ok([16000, 48000].includes(sampleRate));
const streamModels = process.env.TELLUS_BROWSER_STREAM_MODELS !== '0';
const errors = [];
const warnings = [];
try {
  await build({ root, mode: 'engine-integration', define: {
    'import.meta.env.VITE_ACCESS_TOKEN': JSON.stringify('test-access-token'),
    'import.meta.env.VITE_REALTIME_SPEECH_HTTP_URL': JSON.stringify(server.url),
    'import.meta.env.VITE_REALTIME_SPEECH_WS_URL': JSON.stringify(server.url.replace('http:', 'ws:')),
    'import.meta.env.VITE_TELLUS_DENOISE': JSON.stringify(String(streamModels)),
  }, build: { outDir: staticRoot, emptyOutDir: true } });
  browser = await chromium.launch({ headless: true, executablePath: process.env.TELLUS_CHROMIUM_PATH, args: [
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream',
    `--use-file-for-fake-audio-capture=${microphoneWav}`,
  ] });
  const context = await browser.newContext({ permissions: ['microphone', 'local-network-access'] });
  await context.addInitScript(() => {
    window.micRequests = [];
    window.micStreams = [];
    window.workerTimings = [];
    window.workerQueueLatencies = [];
    window.droppedProcessingSamples = [];
    window.audioSendsAfterDenial = 0;
    const OriginalSocket = window.WebSocket;
    window.WebSocket = class extends OriginalSocket {
      denied = false;
      constructor(...args) {
        super(...args);
        this.addEventListener('message', (event) => {
          if (typeof event.data === 'string' && JSON.parse(event.data).type === 'engine.denied') this.denied = true;
        });
      }
      send(data) {
        if (this.denied && data instanceof ArrayBuffer) window.audioSendsAfterDenial++;
        super.send(data);
      }
    };
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      window.micRequests.push(constraints);
      const stream = await getUserMedia(constraints);
      window.micStreams.push(stream);
      return stream;
    };
    const OriginalWorker = window.Worker;
    window.Worker = class extends OriginalWorker {
      pending = new Map();
      constructor(...args) {
        super(...args);
        this.addEventListener('message', (event) => {
          const start = this.pending.get(event.data?.id);
          if (start !== undefined) { window.workerTimings.push(performance.now() - start); this.pending.delete(event.data.id); }
        });
      }
      postMessage(message, ...args) {
        if (message.command?.operation === 'capture') {
          this.pending.set(message.id, performance.now());
          window.workerQueueLatencies.push(Date.now() - message.command.timestamp);
          if (message.command.droppedSamples) window.droppedProcessingSamples.push(message.command.droppedSamples);
        }
        super.postMessage(message, ...args);
      }
    };
  });
  if (process.env.TELLUS_TRACE === '1') {
    await context.route('**/tellus-audio-engine.mjs', async (route) => {
      const response = await route.fetch();
      let body = await response.text();
      body = body.replaceAll('var result=await model.session.run(feeds);', 'console.log("ort-before",handle);var result=await model.session.run(feeds);console.log("ort-after",handle);');
      body = body.replaceAll('return 0}catch(error)', 'console.log("ort-function-return");return 0}catch(error)');
      body = body.replace('Module["ccall"]=ccall;', 'Module["ccall"]=function(...args){console.log("native-before",args[0]);return Promise.resolve(ccall(...args)).then(r=>{console.log("native-after",args[0],r);return r})};');
      await route.fulfill({ response, body });
    });
    await context.route('**/__sdk_probe', async (route) => {
      const response = await route.fetch();
      await route.fulfill({ response, body: (await response.text()).replace('delay(1400)', 'delay(5000)') });
    });
  }
  page = await context.newPage();
  page.on('pageerror', (error) => errors.push(error.stack ?? error.message));
  page.on('console', (message) => { if (process.env.TELLUS_TRACE === '1') console.log('browser-console',message.type(),message.text()); if (message.type() === 'error') {
    if (process.env.TELLUS_TRACE === '1' && message.text().startsWith('pipeline:')) return;
    if (message.text().includes('[W:onnxruntime:')) warnings.push(message.text());
    else errors.push(message.text());
  } });
  if (streamModels) {
    await page.goto(server.url + `/__sdk_probe?sampleRate=${sampleRate}`);
    const beforeGesture = await page.evaluate(async () => {
      const { AudioEngine } = await import('/tellus-audio/platforms/web/index.js');
      const engine = await AudioEngine.init({}, { engineModuleUrl: '/tellus-audio/tellus-audio-engine.mjs', wasmUrl: '/tellus-audio/tellus-audio-engine.wasm', ortWasmBaseUrl: '/tellus-audio/ort/', encryptedModels: [] });
      try {
        const capture = engine.createCapture();
        const status = await capture.getStatus();
        const request = await capture.createAuthorizationRequest('conversation-1');
        return { state: status.state, challenge: !!request.nativeInstanceId, microphoneRequests: window.micRequests.length };
      } finally { await engine.dispose(); }
    });
    assert.deepEqual(beforeGesture, { state: 'idle', challenge: true, microphoneRequests: 0 });
    await page.getByRole('button', { name: 'Run real SDK' }).click();
    await page.waitForFunction(() => ['passed', 'failed'].includes(window.probe.state), { timeout: 30000 });
    const probe = await page.evaluate(() => ({ ...window.probe, isolation: crossOriginIsolated, sharedArrayBuffer: typeof SharedArrayBuffer, timings: window.workerTimings, queueLatencies: window.workerQueueLatencies, queueLosses: window.droppedProcessingSamples, micRequests: window.micRequests, micSettings: window.micStreams.flatMap((stream) => stream.getAudioTracks().map((track) => track.getSettings())) }));
    writeFileSync(resolve(temporary, 'sdk-probe.json'), JSON.stringify(probe, null, 2));
    assert.equal(probe.state, 'passed', JSON.stringify(probe.errors));
    assert.equal(probe.isolation, false);
    assert.equal(probe.sharedArrayBuffer, 'undefined');
    assert.ok(probe.micRequests.every((request) => request.audio.echoCancellation === false && request.audio.noiseSuppression === false && request.audio.autoGainControl === false));
    assert.ok(probe.micSettings.every((settings) => settings.echoCancellation === false && settings.noiseSuppression === false && settings.autoGainControl === false));
    const sorted = probe.timings.toSorted((a, b) => a - b);
    const percentile = (values, ratio) => values[Math.min(values.length - 1, Math.floor(values.length * ratio))];
    console.log(JSON.stringify({ sdk: 'passed', sampleRate, checks: probe.checks, chunks: probe.chunks.length, queueLatencyP95Ms: percentile(probe.queueLatencies.toSorted((a, b) => a - b), 0.95), queueLatencyP99Ms: percentile(probe.queueLatencies.toSorted((a, b) => a - b), 0.99), gaps: probe.chunks.filter((chunk) => chunk.gap).length, queueLostProcessingSamples: probe.queueLosses.reduce((a, b) => a + b, 0), rawPushRoundtripP95Ms: percentile(sorted, 0.95), rawPushRoundtripP99Ms: percentile(sorted, 0.99), callbackLagP99Ms: percentile(probe.chunks.map((chunk) => chunk.lag).toSorted((a, b) => a - b), 0.99), partialTails: probe.chunks.filter((chunk) => chunk.valid < chunk.count).length }));

  }
  await page.goto(server.url);
  if (!streamModels) await page.getByRole('checkbox').uncheck();
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await page.getByText('Status: recording', { exact: true }).waitFor({ timeout: 20000 });
  const until = Date.now() + 5000;
  const initial = server.stats.frames;
  while (server.stats.frames < initial + 10 && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(server.stats.frames >= initial + 10);
  await page.getByText('실제 엔진 통합 테스트', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Pause', exact: true }).click();
  await page.getByText('Status: paused', { exact: true }).waitFor();
  const paused = server.stats.frames;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(server.stats.frames, paused);
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await page.getByText('Status: recording', { exact: true }).waitFor();
  const beforeReconnect = server.stats.authentications;
  server.disconnectAudio();
  await page.getByText('Status: reconnecting', { exact: true }).waitFor();
  await page.getByText('Status: recording', { exact: true }).waitFor({ timeout: 15000 });
  assert.ok(server.stats.authentications > beforeReconnect);
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await page.getByText('Status: ended', { exact: true }).waitFor({ timeout: 10000 });
  const stopped = server.stats.frames;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(server.stats.frames, stopped);
  await page.getByRole('button', { name: 'Start', exact: true }).click();
  await page.getByText('Status: recording', { exact: true }).waitFor({ timeout: 20000 });
  server.denyRenewal();
  await page.getByText('Status: error', { exact: true }).waitFor({ timeout: 5000 });
  const invalidated = server.stats.frames;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(server.stats.frames, invalidated);
  assert.ok(await page.evaluate(() => window.micStreams.every((stream) => stream.getTracks().every((track) => track.readyState === 'ended'))));
  assert.equal(server.stats.preAuthorizationFrames, 0);
  assert.equal(await page.evaluate(() => window.audioSendsAfterDenial), 0);
  assert.ok(server.stats.renewals > 0);
  assert.equal(server.stats.errors.length, 0);
  assert.deepEqual(errors, []);
  writeFileSync(resolve(temporary, 'app-server-stats.json'), JSON.stringify(server.stats, null, 2));
  console.log(JSON.stringify({ app: 'passed', streamModels, authentications: server.stats.authentications, renewals: server.stats.renewals, modelKeyRequests: server.stats.keyRequests, packets: server.stats.frames, beforePermitPackets: server.stats.preAuthorizationFrames, inFlightPacketsAfterServerDenial: server.stats.afterDenialFrames, endings: server.stats.endings, errors, warnings, artifacts: temporary }));
} catch (error) {
  console.error(JSON.stringify({ failure: error.message, errors, stats: server.stats, artifacts: temporary }));
  if (page) writeFileSync(resolve(temporary, 'failure.html'), await page.content().catch(() => ''));
  throw error;
} finally { await browser?.close(); await server.close(); }
