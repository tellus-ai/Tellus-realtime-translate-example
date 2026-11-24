import WebSocket from 'ws';
import type { RealtimeWebSocket } from './RealtimeTranslationSession';

/**
 * Opens a WebSocket from the main process with the `ws` package. The `WebSocket` built into
 * Node.js and Electron reports a server error close as `1006` without the `system.error`, the
 * code, or the reason; see "Node.js clients" in the root README.
 *
 * `ws` sends no Origin header unless one is passed, and its `onmessage` and `onclose` events
 * carry text messages and the close reason as strings, like the browser WebSocket.
 *
 * Both `/v1` WebSockets need a credential. Unlike a browser, `ws` can send a header, so the API
 * key goes in `Authorization`. The server refuses a key in the URL, which could end up in logs.
 */
export function createNodeWebSocket(url: string, apiKey: string): RealtimeWebSocket {
  const socket = new WebSocket(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  // `ws` is an EventEmitter, which throws an 'error' event that has no listener. The session
  // detaches its handlers before it closes a socket, and closing a socket that is still
  // connecting emits 'error'.
  socket.on('error', () => {});
  return socket;
}
