import { createHash } from 'node:crypto';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { constants, deflateRawSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { createNodeWebSocket } from '../electron/realtime/nodeWebSocket';

// These tests run the real `ws` client against servers on localhost.
const SYSTEM_ERROR = JSON.stringify({
  type: 'system.error',
  statusCode: '1008',
  message: ['Conversation not found.'],
  data: { reason: 'conversation_not_found' },
});

let stopServer: (() => void) | null = null;

afterEach(() => {
  stopServer?.();
  stopServer = null;
});

function listen(server: Server): Promise<string> {
  stopServer = () => {
    server.closeAllConnections();
    server.close();
  };
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`));
  });
}

/** Accepts the WebSocket handshake by hand, so that the test decides every byte that follows. */
function acceptUpgrade(headers: IncomingHttpHeaders, socket: Duplex): void {
  const accept = createHash('sha1')
    .update(`${headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    'Sec-WebSocket-Extensions: permessage-deflate',
    '',
    '',
  ].join('\r\n'));
}

/** A compressed text frame followed by a close frame, as the server sends them before an error close. */
function errorCloseFrames(text: string, code: number, reason: string): Buffer {
  // permessage-deflate: raw deflate with a sync flush, without its last four bytes.
  const deflated = deflateRawSync(Buffer.from(text), { finishFlush: constants.Z_SYNC_FLUSH }).subarray(0, -4);
  const closePayload = Buffer.concat([Buffer.from([code >> 8, code & 0xff]), Buffer.from(reason)]);
  return Buffer.concat([
    Buffer.from([0xc1, deflated.length]),
    deflated,
    Buffer.from([0x88, closePayload.length]),
    closePayload,
  ]);
}

describe('createNodeWebSocket', () => {
  it('reports the system.error, the close code, and the reason when the server ends the connection at once', async () => {
    const server = createServer();
    server.on('upgrade', (request, socket) => {
      acceptUpgrade(request.headers, socket);
      socket.end(errorCloseFrames(SYSTEM_ERROR, 1008, 'conversation_not_found'));
    });
    const socket = createNodeWebSocket(await listen(server));
    const messages: unknown[] = [];
    socket.onmessage = (event) => messages.push(event.data);
    const closed = await new Promise<{ code: number; reason: string }>((resolve) => {
      socket.onclose = resolve;
    });

    expect(messages).toEqual([SYSTEM_ERROR]);
    expect(closed).toMatchObject({ code: 1008, reason: 'conversation_not_found' });
  });

  it('sends no Origin header, delivers text as strings, and calls listeners in the order they were added', async () => {
    const headers: IncomingHttpHeaders[] = [];
    const received: Array<{ data: string; isBinary: boolean }> = [];
    const http = createServer();
    const wss = new WebSocketServer({ server: http });
    wss.on('connection', (client, request) => {
      headers.push(request.headers);
      client.on('message', (data, isBinary) => {
        received.push({ data: isBinary ? (data as Buffer).toString('hex') : data.toString(), isBinary });
        if (received.length === 2) client.send('{"type":"engine.authorized"}');
      });
    });
    const socket = createNodeWebSocket(await listen(http));
    expect(socket.readyState).toBe(0);
    const calls: string[] = [];
    await new Promise((resolve) => { socket.onopen = resolve; });
    expect(socket.readyState).toBe(1);

    // The session sets `onmessage` first; the authorization module adds its listener afterwards.
    socket.onmessage = (event) => calls.push(`onmessage ${typeof event.data} ${event.data}`);
    const answered = new Promise((resolve) => {
      socket.addEventListener('message', (event) => {
        calls.push(`listener ${typeof event.data}`);
        resolve(null);
      });
    });
    socket.send('{"type":"audio.status"}');
    socket.send(new Uint8Array([1, 2, 3]));
    await answered;

    expect(headers[0]).not.toHaveProperty('origin');
    expect(received).toEqual([
      { data: '{"type":"audio.status"}', isBinary: false },
      { data: '010203', isBinary: true },
    ]);
    expect(calls).toEqual(['onmessage string {"type":"engine.authorized"}', 'listener string']);

    const closed = new Promise<{ code: number; reason: string }>((resolve) => { socket.onclose = resolve; });
    wss.clients.forEach((client) => client.close(1013, 'worker_capacity_exceeded'));
    expect(await closed).toMatchObject({ code: 1013, reason: 'worker_capacity_exceeded' });
    expect(socket.readyState).toBe(3);
  });

  it('does not throw when a socket without handlers is closed while it is still connecting', async () => {
    // The upgrade request is never answered.
    const server = createServer();
    server.on('upgrade', () => {});
    const socket = createNodeWebSocket(await listen(server));
    // What the session does before it closes a socket.
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    const closed = new Promise<{ code: number }>((resolve) => socket.addEventListener('close', resolve));
    socket.close(1000);

    // `ws` emits 'error' before this close; without a listener that would be an uncaught exception.
    expect(await closed).toMatchObject({ code: 1006 });
  });
});
