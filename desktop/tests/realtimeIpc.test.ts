import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { registerRealtimeIpc, type RealtimeIpcOptions } from '../electron/realtimeIpc';
import type { DesktopResult } from '../electron/shared/desktopApi';

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<DesktopResult<unknown>>;

function setup({ trusted = true } = {}) {
  const handlers = new Map<string, Handler>();
  const session = {
    getSnapshot: vi.fn(() => ({ phase: 'idle' }) as ReturnType<RealtimeIpcOptions['session']['getSnapshot']>),
    start: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
  };
  registerRealtimeIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler as Handler) },
    session,
    isTrustedSender: () => trusted,
  });
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({} as IpcMainInvokeEvent, ...args);
  return { session, invoke };
}

describe('registerRealtimeIpc', () => {
  it('forwards session commands from the trusted renderer', async () => {
    const { session, invoke } = setup();
    const input = { sourceLanguage: 'ko-KR', targetLanguage: 'en-US', clientVad: true };

    await expect(invoke('realtime:get-snapshot')).resolves.toEqual({ ok: true, data: { phase: 'idle' } });
    await expect(invoke('realtime:start', input)).resolves.toEqual({ ok: true, data: null });
    await invoke('realtime:pause');
    await invoke('realtime:resume');
    await invoke('realtime:stop');

    expect(session.start).toHaveBeenCalledWith(input);
    expect(session.pause).toHaveBeenCalledOnce();
    expect(session.resume).toHaveBeenCalledOnce();
    expect(session.stop).toHaveBeenCalledOnce();
  });

  it('blocks untrusted senders before touching the session', async () => {
    const { session, invoke } = setup({ trusted: false });

    const result = await invoke('realtime:stop');
    expect(result).toMatchObject({ ok: false, error: { message: expect.stringContaining('untrusted sender') } });
    expect(session.stop).not.toHaveBeenCalled();
  });

  it('validates start input from the renderer', async () => {
    const { session, invoke } = setup();

    await expect(invoke('realtime:start', {
      sourceLanguage: 'ko-KR"',
      targetLanguage: 'en-US',
      clientVad: true,
    })).resolves.toMatchObject({ ok: false, error: { message: 'Invalid interpretation settings.' } });
    await expect(invoke('realtime:start', null)).resolves.toMatchObject({ ok: false });
    expect(session.start).not.toHaveBeenCalled();
  });
});
