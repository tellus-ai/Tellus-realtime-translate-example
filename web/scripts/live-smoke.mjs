import WebSocket from 'ws';

const httpBaseUrl = requiredEnvironment('VITE_REALTIME_SPEECH_HTTP_URL').replace(/\/+$/, '');
const websocketBaseUrl = requiredEnvironment('VITE_REALTIME_SPEECH_WS_URL').replace(/\/+$/, '');
const accessToken = requiredEnvironment('API_KEY');
const origin = process.env.SMOKE_ORIGIN || 'http://127.0.0.1:4173';

let conversationId = null;
let resultSocket = null;
let audioSocket = null;

try {
  console.log('1/6 health 확인');
  await requestJson('/health', { authenticated: false });

  console.log('2/6 Conversation 생성');
  const conversation = await requestJson('/conversations', {
    body: {
      max_concurrent_viewers: 10,
      conversation_audio_mode: 'single_speaker',
    },
  });
  conversationId = readConversationId(conversation);

  console.log('3/6 번역 설정 저장');
  await requestJson(`/conversations/${encodeURIComponent(conversationId)}/interpretation-settings`, {
    body: {
      languages: ['ko-KR', 'en-US'],
      transcription: { client_vad: false },
      translation: {},
    },
  });

  console.log('4/6 Result WebSocket 연결');
  resultSocket = createSocket(
    `${websocketBaseUrl}/conversations/${encodeURIComponent(conversationId)}/results`,
  );
  const resultReady = waitForResultReady(resultSocket);
  await waitForOpen(resultSocket);
  await resultReady;

  console.log('5/6 Audio WebSocket 연결 및 PCM16 전송');
  audioSocket = createSocket(
    `${websocketBaseUrl}/audio?conversation_id=${encodeURIComponent(conversationId)}&audio_format=pcm16`,
  );
  await waitForOpen(audioSocket);
  await sendSilence(audioSocket);

  console.log('6/6 원격 연결 smoke 성공');
} finally {
  closeSocket(audioSocket);
  closeSocket(resultSocket);
  if (conversationId !== null) {
    console.log('정리: 테스트 Conversation 종료');
    await requestJson(`/conversations/${encodeURIComponent(conversationId)}/end`, { method: 'POST' });
  }
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} 환경변수가 필요합니다.`);
  return value;
}

async function requestJson(path, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (options.authenticated !== false) headers.Authorization = `Bearer ${accessToken}`;
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
  return typeof body.message === 'string' ? body.message : '';
}

function readConversationId(body) {
  const value = body && typeof body === 'object' ? body.conversation_id : null;
  if (typeof value !== 'string' || !value) throw new Error('응답에 conversation_id가 없습니다.');
  return value;
}

function createSocket(url) {
  return new WebSocket(url, { headers: { Origin: origin } });
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

function waitForResultReady(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('participants.snapshot timeout')), 10_000);
    socket.on('message', (data) => {
      let payload;
      try { payload = JSON.parse(data.toString()); } catch { return; }
      if (payload?.type === 'system.error') {
        clearTimeout(timeout);
        reject(new Error(readPublicMessage(payload) || 'Result WebSocket system.error'));
      } else if (payload?.type === 'participants.snapshot') {
        clearTimeout(timeout);
        resolve();
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
