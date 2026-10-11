import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { extname, resolve, sep } from 'node:path';
import { WebSocketServer } from 'ws';
import { wrapContentKey } from './test-hpke-wrap.cjs';

// 공개 CI 서명 키와 명시한 임시 CEK만 사용하는 localhost 테스트 서버다.
export async function startEngineTestServer({ engineRoot, keyFile, modelDir, staticRoot, probeHtml, stereoWav }) {
  if (process.env.TELLUS_ENGINE_TEST_LICENSE !== '1') throw new Error('Set TELLUS_ENGINE_TEST_LICENSE=1 for test-only engine artifacts');
  const require = createRequire(import.meta.url);
  const { signTestPermit } = require(resolve(engineRoot, 'scripts/ci/engine-authorization-fixture.js'));
  const contentKey = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'hex');
  if (contentKey.length !== 32) throw new Error('Expected a 32-byte test content key');
  const registry = JSON.parse(readFileSync(resolve(modelDir, 'manifest.json'), 'utf8')).models;
  const stats = { authentications: 0, renewals: 0, keyRequests: 0, frames: 0, preAuthorizationFrames: 0, afterDenialFrames: 0, statuses: [], packetSizes: [], endings: 0, errors: [] };
  const audio = new Set();
  const results = new Set();
  let denyRenewal = false;
  const mime = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm' };
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1');
    const reply = (value) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
    if (request.method === 'POST') {
      if (url.pathname === '/conversations') return reply({ conversation_id: 'conversation-1' });
      if (url.pathname.endsWith('/interpretation-settings')) return reply({});
      if (url.pathname.endsWith('/end')) {
        stats.endings++;
        for (const socket of results) socket.send(JSON.stringify({ type: 'conversation.ended', data: {} }));
        return reply({});
      }
    }
    let file = url.pathname === '/__sdk_probe' ? probeHtml : url.pathname === '/stereo.wav' ? stereoWav : resolve(staticRoot, `.${decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)}`);
    if (![probeHtml, stereoWav].includes(file) && !file.startsWith(resolve(staticRoot) + sep)) { response.writeHead(403); return response.end(); }
    if (!existsSync(file) || !statSync(file).isFile()) { response.writeHead(404); return response.end(); }
    response.writeHead(200, { 'content-type': mime[extname(file)] ?? 'application/octet-stream' });
    response.end(readFileSync(file));
  });
  const websocket = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  server.on('upgrade', (request, socket, head) => websocket.handleUpgrade(request, socket, head, (peer) => {
    const isAudio = request.url.startsWith('/audio?');
    const group = isAudio ? audio : results;
    group.add(peer);
    peer.on('close', () => group.delete(peer));
    if (!isAudio) peer.send(JSON.stringify({ type: 'participants.snapshot', data: {} }));
    let authorized = false;
    let wasAuthorized = false;
    let transcribed = false;
    peer.on('message', (bytes, binary) => {
      try {
        if (binary) {
          stats.frames++;
          stats.packetSizes.push(bytes.length);
          // 거절 응답을 보내기 전에 송신된 패킷은 네트워크에서 늦게 도착할 수 있다.
          if (!authorized) {
            if (wasAuthorized) stats.afterDenialFrames++;
            else stats.preAuthorizationFrames++;
          }
          if (!transcribed) {
            transcribed = true;
            for (const result of results) result.send(JSON.stringify({
              type: 'result', data: { conversation_id: 'conversation-1', event_type: 'transcript.final', order_seq: 1, text: '실제 엔진 통합 테스트', source_language: 'ko-KR', target_language: null },
            }));
          }
          return;
        }
        const message = JSON.parse(bytes.toString());
        if (message.type === 'audio.status') { stats.statuses.push(message); return; }
        if (!['audio.authenticate', 'engine.renew'].includes(message.type) || message.access_token !== 'test-access-token') throw new Error('Invalid fixture authentication');
        const renewal = message.type === 'engine.renew';
        if (renewal) stats.renewals++; else stats.authentications++;
        if (renewal && denyRenewal) {
          authorized = false;
          peer.send(JSON.stringify({ type: 'engine.denied', version: 1, sequence: message.engine.sequence, code: 'engine_access_denied', retryable: false }));
          return;
        }
        const keys = (message.model_keys ?? []).map((key) => {
          if (!registry.some((model) => model.id === key.model_id && model.keyId === key.key_id)) throw new Error('Unknown fixture model');
          stats.keyRequests++;
          return { model_id: key.model_id, key_id: key.key_id, wrapped_key: wrapContentKey({
            recipientPublicKey: Buffer.from(key.public_key, 'hex'), contentKey,
            binding: { nativeInstanceId: message.engine.native_instance_id, modelId: key.model_id, keyId: key.key_id },
          }).toString('base64url') };
        });
        const token = signTestPermit({ nativeInstanceId: message.engine.native_instance_id, nonce: message.engine.nonce, sequence: message.engine.sequence }, { ttlMs: 20000, conversationId: 'conversation-1' });
        authorized = true;
        wasAuthorized = true;
        peer.send(JSON.stringify({ type: renewal ? 'engine.renewed' : 'engine.authorized', version: 1, sequence: message.engine.sequence, token, renew_after_ms: 1000, ...(keys.length ? { model_keys: keys } : {}) }));
      } catch (error) { stats.errors.push(error.message); peer.close(1008, 'fixture_error'); }
    });
  }));
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`, stats,
    disconnectAudio: () => { for (const socket of audio) socket.terminate(); },
    denyRenewal: () => { denyRenewal = true; },
    close: async () => { for (const socket of [...audio, ...results]) socket.terminate(); await new Promise((done) => websocket.close(done)); await new Promise((done) => server.close(done)); contentKey.fill(0); },
  };
}
