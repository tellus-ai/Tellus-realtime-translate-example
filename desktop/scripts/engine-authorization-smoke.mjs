// Uses a separate conversation and never enables microphone/speaker capture.
import assert from 'node:assert/strict';
import { AudioCapture } from '@tellus-ai/audio-sdk';
import { attachEngineAuthorization } from '@tellus-ai/audio-sdk/authorization';

const httpBase = process.env.REALTIME_SPEECH_HTTP_URL || 'https://stgrtsapi.tellus.ai.kr';
const wsBase = process.env.REALTIME_SPEECH_WS_URL || 'wss://stgrtsapi.tellus.ai.kr';
const token = process.env.API_KEY;
if (!token) throw new Error('Set API_KEY to a login access token.');
if (new URL(httpBase).protocol !== 'https:' || new URL(wsBase).protocol !== 'wss:') {
  throw new Error('Use HTTPS and WSS endpoints for the live authorization test.');
}

async function post(path, body) {
  const response = await fetch(`${httpBase.replace(/\/$/, '')}${path}`, {
    method: 'POST', redirect: 'error', signal: AbortSignal.timeout(20_000),
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'tellus-audio-sdk-installer' },
    body: JSON.stringify(body),
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
  const conversation = await post('/conversations', { max_concurrent_viewers: 1, conversation_audio_mode: 'single_speaker' });
  conversationId = conversation.conversation_id;
  assert.equal(typeof conversationId, 'string');
  await post(`/conversations/${encodeURIComponent(conversationId)}/interpretation-settings`, { languages: ['ko-KR'] });
  socket = new WebSocket(`${wsBase.replace(/\/$/, '')}/audio?conversation_id=${encodeURIComponent(conversationId)}`);
  controller = attachEngineAuthorization(socket, capture, {
    conversationId,
    getAccessToken: () => { credentialRequests++; return token; },
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
    await post(`/conversations/${encodeURIComponent(conversationId)}/end`, {});
    console.log('PASS: isolated test conversation ended.');
  }
}
