// What to do when a realtime WebSocket closes. The rules follow
// "Close codes and recommended client behavior" in the root README.

export type RealtimeSocket = 'result' | 'audio';

/** A `system.error` message. The server sends one right before most error closes. */
export interface SystemError {
  /** `statusCode`: the close code that follows. */
  code: number | null;
  /** `data.reason`: a stable code. The close frame repeats it as its reason text. */
  reason: string | null;
  /** `message[0]`, for display. */
  message: string;
  /** `data.retry_after_ms`, sent with the `/audio` reconnect rate limit. */
  retryAfterMs: number | null;
}

export interface SocketClose {
  code: number;
  /** `CloseEvent.reason`. */
  reason: string;
  /** The last `system.error` received on the socket that closed. */
  lastError: SystemError | null;
  /** Reconnects scheduled since the connection last stayed open for `STABLE_CONNECTION_MS`. */
  attempt: number;
  random?: () => number;
}

export type CloseDecision =
  /** The Conversation is over. Show it as ended; do not reconnect and do not call `POST /end`. */
  | { action: 'ended'; reason: string | null }
  /** The server refused the connection. Stop and show `message`; reconnecting does not help. */
  | { action: 'fail'; reason: string | null; message: string; endConversation: boolean }
  | { action: 'reconnect'; reason: string | null; delayMs: number };

export const RECONNECT_DELAYS_MS = [1_000, 2_000, 5_000, 10_000, 30_000];
// The server can close a socket right after accepting it, so an open socket alone does not
// reset the backoff.
export const STABLE_CONNECTION_MS = 30_000;

// The `engine_*` reasons belong to the native engine authorization on `/audio`.
const ENDED_REASONS = new Set(['conversation_ended', 'conversation_not_found', 'engine_conversation_inactive']);
const REPLACED_REASONS = new Set(['audio_connection_replaced', 'engine_connection_superseded']);
const AUTHORIZATION_EXPIRED_REASON = 'engine_authorization_expired';

export function reconnectDelayMs(attempt: number): number {
  return RECONNECT_DELAYS_MS[Math.min(Math.max(attempt, 0), RECONNECT_DELAYS_MS.length - 1)];
}

export function decideSocketClose(close: SocketClose): CloseDecision {
  const reason = close.reason || close.lastError?.reason || null;

  if (close.code === 1000) return { action: 'ended', reason };

  // The only 1008 that a reconnect repairs: the engine permit ran out before it was renewed,
  // and a new `/audio` socket is authorized from the start.
  if (close.code === 1008 && reason !== AUTHORIZATION_EXPIRED_REASON) {
    if (reason !== null && ENDED_REASONS.has(reason)) return { action: 'ended', reason };
    if (reason !== null && REPLACED_REASONS.has(reason)) {
      return {
        action: 'fail',
        reason,
        message: 'Another device or tab took over the audio of this Conversation.',
        // The Conversation is still in use there, so this client leaves it open.
        endConversation: false,
      };
    }
    return { action: 'fail', reason, message: describeRejection(close, reason), endConversation: true };
  }

  // 1012 is a server restart: spread the first reconnect so clients do not return at once.
  if (close.code === 1012 && close.attempt === 0) {
    const random = close.random ?? Math.random;
    return { action: 'reconnect', reason, delayMs: 500 + Math.floor(random() * 1_500) };
  }

  // Every other code is temporary, including 1006 (no close frame) and codes added later.
  const delayMs = Math.max(reconnectDelayMs(close.attempt), close.lastError?.retryAfterMs ?? 0);
  return { action: 'reconnect', reason, delayMs };
}

function describeRejection(close: SocketClose, reason: string | null): string {
  const message = close.lastError?.message;
  if (message) return reason ? `${message} (${reason})` : message;
  return `The server refused the connection. (${reason ?? close.code})`;
}
