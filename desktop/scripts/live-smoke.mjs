import WebSocket from 'ws';

const httpBaseUrl = requiredEnvironment('REALTIME_SPEECH_HTTP_URL').replace(/\/+$/, '');
const websocketBaseUrl = requiredEnvironment('REALTIME_SPEECH_WS_URL').replace(/\/+$/, '');
const apiKey = requiredEnvironment('API_KEY');
// This script stands in for both the example API server (it holds the API key for the REST calls)
// and the app (it connects with the access token, from Node.js, without an Origin header).
// Set SMOKE_ORIGIN to check how the server treats a browser origin instead.
const origin = process.env.SMOKE_ORIGIN;

let conversationId = null;
let accessToken = null;
let resultSocket = null;
let audioSocket = null;

try {
  console.log('1/7 health 확인');
  await requestJson('/health', { authenticated: false });

  console.log('2/7 Conversation 생성');
  // 본문 없이 만든다. 설정은 다음 호출에서 저장한다.
  const conversation = await requestJson('/v1/conversations', { method: 'POST' });
  conversationId = readConversationId(conversation);

  console.log('3/7 번역 설정 저장');
  await requestJson(`/v1/conversations/${encodeURIComponent(conversationId)}/settings`, {
    body: {
      languages: ['ko-KR', 'en-US'],
      transcription: { client_vad: false },
    },
  });

  // 앱처럼 입장권으로 두 WebSocket을 연다. API 키는 REST 호출에만 쓴다.
  console.log('4/7 입장권 발급');
  const issued = await requestJson('/v1/access-tokens', {
    body: { session_kind: 'conversation', session_id: conversationId },
  });
  if (typeof issued?.access_token !== 'string' || !issued.access_token) throw new Error('응답에 access_token이 없습니다.');
  accessToken = issued.access_token;

  console.log('5/7 Result WebSocket 연결');
  resultSocket = createSocket(
    `${websocketBaseUrl}/v1/conversations/${encodeURIComponent(conversationId)}/results`,
  );
  // /v1 연결은 ready 메시지를 보내지 않는다. 서버는 연결을 받은 직후에도 거절할 수 있으므로
  // 열린 뒤 잠시 동안 system.error나 close가 오지 않는지 확인한다.
  await Promise.all([waitForOpen(resultSocket), waitForAcceptance(resultSocket, 'Result')]);

  console.log('6/7 Audio WebSocket 연결 및 PCM16 전송');
  audioSocket = createSocket(
    `${websocketBaseUrl}/v1/audio?conversation_id=${encodeURIComponent(conversationId)}&audio_format=pcm16`,
  );
  const socket = audioSocket;
  await Promise.all([
    waitForOpen(socket).then(() => sendSilence(socket)),
    waitForAcceptance(socket, 'Audio'),
  ]);

  console.log('7/7 원격 연결 smoke 성공');
} finally {
  closeSocket(audioSocket);
  closeSocket(resultSocket);
  if (conversationId !== null) {
    console.log('정리: 테스트 Conversation 종료');
    await requestJson(`/v1/conversations/${encodeURIComponent(conversationId)}/end`, { method: 'POST' });
  }
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} 환경변수가 필요합니다.`);
  return value;
}

async function requestJson(path, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (options.authenticated !== false) headers.Authorization = `Bearer ${apiKey}`;
  const response = await fetch(`${httpBaseUrl}${path}`, {
    method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }
  if (!response.ok) {
    throw new Error(`${path} 요청 실패: HTTP ${response.status} ${readPublicMessage(body)}`.trim());
  }
  return unwrapEnvelope(body);
}

function unwrapEnvelope(body) {
  return body && typeof body === 'object' && 'data' in body ? body.data : body;
}

function readPublicMessage(body) {
  if (!body || typeof body !== 'object') return typeof body === 'string' ? body : '';
  if (Array.isArray(body.message)) return body.message.find((item) => typeof item === 'string') || '';
  if (typeof body.message === 'string') return body.message;
  // POST /v1/access-tokens는 오류를 {"detail": "..."}로 돌려준다.
  return typeof body.detail === 'string' ? body.detail : '';
}

function readConversationId(body) {
  const value = body && typeof body === 'object' ? body.conversation_id : null;
  if (typeof value !== 'string' || !value) throw new Error('응답에 conversation_id가 없습니다.');
  return value;
}

// /v1 WebSocket은 자격 증명이 필요하다. 앱처럼 입장권을 URL이 아니라 handshake 헤더로 보낸다.
function createSocket(url) {
  return new WebSocket(url, {
    headers: { Authorization: `Bearer ${accessToken}`, ...(origin ? { Origin: origin } : {}) },
  });
}

function waitForOpen(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebSocket open timeout')), 10_000);
    socket.once('open', () => { clearTimeout(timeout); resolve(); });
    socket.once('error', (error) => { clearTimeout(timeout); reject(error); });
    socket.once('close', (code, reason) => {
      if (socket.readyState !== WebSocket.OPEN) {
        clearTimeout(timeout);
        reject(new Error(`WebSocket closed before open: ${code} ${reason.toString()}`));
      }
    });
  });
}

/** 연결이 열린 뒤 1초 동안 서버가 거절하지 않으면 받아들인 것으로 본다. */
function waitForAcceptance(socket, name) {
  return new Promise((resolve, reject) => {
    let timeout = null;
    const fail = (message) => { clearTimeout(timeout); reject(new Error(`${name} WebSocket ${message}`)); };
    socket.once('open', () => { timeout = setTimeout(resolve, 1_000); });
    socket.on('close', (code, reason) => fail(`closed: ${code} ${reason.toString()}`));
    socket.on('message', (data, isBinary) => {
      if (isBinary) return;
      let payload;
      try { payload = JSON.parse(data.toString()); } catch { return; }
      if (payload?.type === 'system.error') {
        fail(`system.error: ${readPublicMessage(payload)} (${payload.data?.reason ?? 'no reason'})`);
      } else if (payload?.type === 'result' || payload?.type === 'participants.snapshot') {
        // 버전 없는 /conversations 경로의 메시지 모양이다. /v1 연결에는 오지 않아야 한다.
        fail(`sent a message of the unversioned routes: ${payload.type}`);
      }
    });
  });
}

async function sendSilence(socket) {
  let sample = 0;
  socket.send(JSON.stringify(audioStatus('capturing', sample, 1)));
  for (let index = 0; index < 25; index += 1) {
    socket.send(Buffer.alloc(640));
    sample += 320;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  socket.send(JSON.stringify(audioStatus('idle', sample, 2)));
}

function audioStatus(state, sample, sequence) {
  return {
    type: 'audio.status',
    version: 1,
    status_seq: sequence,
    boundary_sample: sample,
    mic: { state },
    vad: {
      enabled: false,
    },
  };
}

function closeSocket(socket) {
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
    socket.close(1000);
  }
}
