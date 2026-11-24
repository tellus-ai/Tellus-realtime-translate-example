import WebSocket from 'ws';

const httpBaseUrl = requiredEnvironment('VITE_REALTIME_SPEECH_HTTP_URL').replace(/\/+$/, '');
const websocketBaseUrl = requiredEnvironment('VITE_REALTIME_SPEECH_WS_URL').replace(/\/+$/, '');
const apiKey = requiredEnvironment('API_KEY');
const origin = process.env.SMOKE_ORIGIN || 'http://127.0.0.1:4173';

// 서버가 연결을 받은 직후 system.error와 close로 거절할 수 있어, 끝까지 기록해 둔다.
const refusals = [];
let conversationId = null;
let resultSocket = null;
let audioSocket = null;

try {
  console.log('1/7 health 확인');
  await requestJson('/health', { authenticated: false });

  console.log('2/7 Conversation 생성');
  const conversation = await requestJson('/v1/conversations', { method: 'POST' });
  conversationId = readConversationId(conversation);
  const id = encodeURIComponent(conversationId);

  console.log('3/7 번역 설정 저장');
  await requestJson(`/v1/conversations/${id}/settings`, {
    body: {
      languages: ['ko-KR', 'en-US'],
      transcription: { client_vad: false },
    },
  });

  // 브라우저는 WebSocket에 API 키를 실을 수 없으므로 웹 예제와 같이 입장권으로 연다.
  console.log('4/7 입장권 발급');
  const issued = await requestJson('/v1/access-tokens', {
    body: { session_kind: 'conversation', session_id: conversationId },
  });
  if (typeof issued?.access_token !== 'string' || !issued.access_token) throw new Error('응답에 access_token이 없습니다.');
  const token = encodeURIComponent(issued.access_token);

  // ready 메시지가 없다. 연결이 열리면 쓸 수 있다.
  console.log('5/7 Result WebSocket 연결');
  resultSocket = createSocket('Result', `${websocketBaseUrl}/v1/conversations/${id}/results?token=${token}`);
  await waitForOpen(resultSocket);

  console.log('6/7 Audio WebSocket 연결 및 PCM16 전송');
  audioSocket = createSocket('Audio', `${websocketBaseUrl}/v1/audio?conversation_id=${id}&audio_format=pcm16&token=${token}`);
  await waitForOpen(audioSocket);
  await sendSilence(audioSocket);
  if (refusals.length > 0) throw new Error(`서버가 연결을 거절했습니다: ${refusals.join('; ')}`);

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

function createSocket(name, url) {
  const socket = new WebSocket(url, { headers: { Origin: origin } });
  let closedHere = false;
  socket.closeFromHere = () => { closedHere = true; socket.close(1000); };
  socket.on('message', (data, isBinary) => {
    if (isBinary) return;
    let payload;
    try { payload = JSON.parse(data.toString()); } catch { return; }
    if (payload?.type === 'system.error') refusals.push(`${name} system.error ${payload.data?.reason ?? ''} ${readPublicMessage(payload)}`.trim());
  });
  socket.on('close', (code, reason) => {
    if (!closedHere) refusals.push(`${name} closed ${code} ${reason.toString()}`.trim());
  });
  return socket;
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
    socket.closeFromHere();
  }
}
