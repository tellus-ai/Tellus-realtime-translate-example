// Uses a separate conversation and never enables microphone/speaker capture.
import assert from 'node:assert/strict';
import { AudioCapture } from '@tellus-ai/audio-sdk-desktop';
import { attachEngineAuthorization } from '@tellus-ai/audio-sdk-desktop/authorization';
// As in the app (electron/realtime/nodeWebSocket.ts): `ws` can send the API key in a header.
import WebSocket from 'ws';

const httpBase = process.env.REALTIME_SPEECH_HTTP_URL || 'https://public.speech.tellus.ai.kr';
const wsBase = process.env.REALTIME_SPEECH_WS_URL || 'wss://public.speech.tellus.ai.kr';
const apiKey = process.env.API_KEY;
if (!apiKey) throw new Error('Set API_KEY to an API key issued in the Tellus API Console.');
if (new URL(httpBase).protocol !== 'https:' || new URL(wsBase).protocol !== 'wss:') {
  throw new Error('Use HTTPS and WSS endpoints for the live authorization test.');
}

async function post(path, body) {
  const response = await fetch(`${httpBase.replace(/\/$/, '')}${path}`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'User-Agent': 'tellus-audio-sdk-installer' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`Live authorization test request failed: HTTP ${response.status}`);
  const result = await response.json();
  return result.data ?? result;
}

const capture = new AudioCapture({ micEnabled: false, speakerEnabled: false, denoiseEnabled: false, vadEnabled: false });
let conversationId;
let socket;
let controller;
let credentialRequests = 0;
try {
  assert.throws(() => capture.start(() => {}), /engine_authorization_required/);
  const conversation = await post('/v1/conversations');
  conversationId = conversation.conversation_id;
  assert.equal(typeof conversationId, 'string');
  // A /v1 Conversation has two or three languages.
  await post(`/v1/conversations/${encodeURIComponent(conversationId)}/settings`, { languages: ['ko-KR', 'en-US'] });
  // `/v1/audio` needs a credential in the handshake as well as in `audio.authenticate`.
  socket = new WebSocket(
    `${wsBase.replace(/\/$/, '')}/v1/audio?conversation_id=${encodeURIComponent(conversationId)}`,
    { headers: { Authorization: `Bearer ${apiKey}` } },
  );
  // `ws` throws an 'error' event that has no listener.
  socket.on('error', () => {});
  controller = attachEngineAuthorization(socket, capture, {
    conversationId,
    getAccessToken: () => { credentialRequests++; return apiKey; },
    onError: () => { process.exitCode = 1; },
  });
  let timeout;
  try {
    await Promise.race([
      controller.ready,
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Live authorization timed out.')), 20_000); }),
    ]);
  } finally { clearTimeout(timeout); }
  assert.equal(capture.getAuthorizationStatus().state, 'authorized');
  assert.equal(credentialRequests, 1);
  assert.throws(() => capture.applyAuthorization('invalid-token'), /engine_authorization_invalid/);
  controller.dispose();
  assert.equal(capture.getAuthorizationStatus().state, 'unapproved');
  assert.throws(() => capture.start(() => {}), /engine_authorization_required/);
  console.log('PASS: live engine approval, invalid permit rejection, disposal, and unapproved start rejection. No audio captured.');
} finally {
  controller?.dispose();
  socket?.close();
  capture.stop();
  if (conversationId) {
    await post(`/v1/conversations/${encodeURIComponent(conversationId)}/end`);
    console.log('PASS: isolated test conversation ended.');
  }
}
