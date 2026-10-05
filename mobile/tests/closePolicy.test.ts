import {
  decideSocketClose,
  reconnectDelayMs,
  type SocketClose,
  type SystemError,
} from '../src/realtime/closePolicy';

function systemError(code: number, reason: string, message: string, retryAfterMs: number | null = null): SystemError {
  return { code, reason, message, retryAfterMs };
}

function close(patch: Partial<SocketClose> & { code: number }): SocketClose {
  return { reason: '', lastError: null, attempt: 0, ...patch };
}

describe('decideSocketClose', () => {
  it('treats 1000 as the end of the Conversation', () => {
    expect(decideSocketClose(close({ code: 1000, reason: 'conversation_ended' }))).toEqual({
      action: 'ended',
      reason: 'conversation_ended',
    });
    expect(decideSocketClose(close({ code: 1000 }))).toEqual({ action: 'ended', reason: null });
  });

  it.each(['conversation_ended', 'conversation_not_found'])(
    'treats 1008 %s as ended',
    (reason) => {
      expect(decideSocketClose(close({ code: 1008, reason }))).toEqual({ action: 'ended', reason });
    },
  );

  it('reads the reason from system.error when the close frame has none', () => {
    const lastError = systemError(1008, 'conversation_ended', 'Conversation has already ended.');
    expect(decideSocketClose(close({ code: 1008, lastError }))).toEqual({
      action: 'ended',
      reason: 'conversation_ended',
    });
  });

  it('stops without ending the Conversation when another connection replaced /audio', () => {
    expect(decideSocketClose(close({ code: 1008, reason: 'audio_connection_replaced' }))).toEqual({
      action: 'fail',
      reason: 'audio_connection_replaced',
      message: 'Another device or tab took over the audio of this Conversation.',
      endConversation: false,
    });
  });

  it.each([
    ['origin_not_allowed', 'Permission denied.'],
    ['interpretation_settings_changed', 'Interpretation worker revision conflict.'],
    ['interpretation_settings_not_found', 'Interpretation settings were not found.'],
    ['invalid_audio_status', 'Invalid audio status message.'],
    ['a_reason_added_later', 'Invalid request.'],
  ])('does not reconnect after 1008 %s', (reason, message) => {
    const lastError = systemError(1008, reason, message);
    expect(decideSocketClose(close({ code: 1008, reason, lastError, attempt: 3 }))).toEqual({
      action: 'fail',
      reason,
      message: `${message} (${reason})`,
      endConversation: true,
    });
  });

  it('describes a 1008 close that carries neither a reason nor a system.error', () => {
    expect(decideSocketClose(close({ code: 1008 }))).toEqual({
      action: 'fail',
      reason: null,
      message: 'The server refused the connection. (1008)',
      endConversation: true,
    });
  });

  it.each([
    [1006, ''],
    [1011, 'internal_error'],
    [1011, 'keepalive ping timeout'],
    [1013, 'result_send_failed'],
    [1013, 'temporarily_unavailable'],
    [1014, ''],
    [4000, 'a_code_added_later'],
  ])('reconnects with backoff after %i %s', (code, reason) => {
    expect(decideSocketClose(close({ code, reason }))).toEqual({
      action: 'reconnect',
      reason: reason || null,
      delayMs: 1_000,
    });
    expect(decideSocketClose(close({ code, reason, attempt: 2 }))).toMatchObject({ delayMs: 5_000 });
  });

  it('waits at least retry_after_ms after the /audio reconnect rate limit', () => {
    const reason = 'audio_pipeline_activation_rate_limited';
    const lastError = systemError(1013, reason, 'Audio pipeline reconnect rate limit exceeded.', 800);
    expect(decideSocketClose(close({ code: 1013, reason, lastError }))).toEqual({
      action: 'reconnect',
      reason,
      delayMs: 1_000,
    });
    const longer = { ...lastError, retryAfterMs: 1_700 };
    expect(decideSocketClose(close({ code: 1013, reason, lastError: longer }))).toMatchObject({ delayMs: 1_700 });
    expect(decideSocketClose(close({ code: 1013, reason, lastError: longer, attempt: 3 }))).toMatchObject({
      delayMs: 10_000,
    });
  });

  it('spreads the first reconnect after a server restart, then backs off', () => {
    expect(decideSocketClose(close({ code: 1012, random: () => 0 }))).toMatchObject({ delayMs: 500 });
    expect(decideSocketClose(close({ code: 1012, random: () => 0.999 }))).toMatchObject({ delayMs: 1_998 });
    expect(decideSocketClose(close({ code: 1012, attempt: 1, random: () => 0 }))).toMatchObject({ delayMs: 2_000 });
  });
});

describe('reconnectDelayMs', () => {
  it('waits 1, 2, 5, 10, and 30 seconds, then every 30 seconds', () => {
    expect([0, 1, 2, 3, 4, 5, 20].map(reconnectDelayMs)).toEqual([
      1_000, 2_000, 5_000, 10_000, 30_000, 30_000, 30_000,
    ]);
  });
});
