import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { registerRealtimeIpc, type RealtimeIpcOptions } from '../electron/realtimeIpc';
import type { DesktopResult } from '../electron/shared/desktopApi';

type Handler = (event: IpcMainInvokeEvent, ...args: unknown[]) => Promise<DesktopResult<unknown>>;

function setup({ trusted = true } = {}) {
  const handlers = new Map<string, Handler>();
  const session = {
    getRecording: vi.fn(() => ({ fileName: 'tellus-recording-test.ogg', data: new Uint8Array([1, 2, 3]) })),
    getSnapshot: vi.fn(() => ({ phase: 'idle' }) as ReturnType<RealtimeIpcOptions['session']['getSnapshot']>),
    start: vi.fn(async () => {}),
    pause: vi.fn(async () => {}),
    resume: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    setDenoiseEnabled: vi.fn(async () => {}),
  };
  const saveRecording = vi.fn(async () => '/Downloads/tellus-recording-test.ogg');
  registerRealtimeIpc({
    ipcMain: { handle: (channel, handler) => handlers.set(channel, handler as Handler) },
    session,
    saveRecording,
    isTrustedSender: () => trusted,
  });
  const invoke = (channel: string, ...args: unknown[]) => handlers.get(channel)!({} as IpcMainInvokeEvent, ...args);
  return { session, saveRecording, invoke };
}

describe('registerRealtimeIpc', () => {
  it('saves main-owned audio to the main-owned Downloads destination', async () => {
    const { session, saveRecording, invoke } = setup();
    await expect(invoke('realtime:download-audio', '/untrusted-path')).resolves.toEqual({ ok: true, data: '/Downloads/tellus-recording-test.ogg' });
    expect(saveRecording).toHaveBeenCalledWith(session.getRecording.mock.results[0].value);
  });

  it('blocks audio downloads from untrusted senders', async () => {
    const { session, saveRecording, invoke } = setup({ trusted: false });
    await expect(invoke('realtime:download-audio')).resolves.toMatchObject({ ok: false });
    expect(session.getRecording).not.toHaveBeenCalled();
    expect(saveRecording).not.toHaveBeenCalled();
  });

  it('returns download failures to the renderer', async () => {
    const { saveRecording, invoke } = setup();
    saveRecording.mockRejectedValueOnce(new Error('Disk is full.'));
    await expect(invoke('realtime:download-audio')).resolves.toMatchObject({ ok: false, error: { message: 'Disk is full.' } });
  });
  it('forwards session commands from the trusted renderer', async () => {
    const { session, invoke } = setup();
    const input = { sourceLanguage: 'ko-KR', targetLanguage: 'en-US', clientVad: true };

    await expect(invoke('realtime:get-snapshot')).resolves.toEqual({ ok: true, data: { phase: 'idle' } });
    await expect(invoke('realtime:start', input)).resolves.toEqual({ ok: true, data: null });
    await invoke('realtime:pause');
    await invoke('realtime:resume');
    await invoke('realtime:stop');
    await invoke('realtime:set-denoise', true);

    expect(session.start).toHaveBeenCalledWith(input);
    expect(session.pause).toHaveBeenCalledOnce();
    expect(session.resume).toHaveBeenCalledOnce();
    expect(session.stop).toHaveBeenCalledOnce();
    expect(session.setDenoiseEnabled).toHaveBeenCalledWith(true);
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

  it.each([null, 'true', 1, {}])('rejects invalid denoise settings: %j', async (enabled) => {
    const { session, invoke } = setup();
    await expect(invoke('realtime:set-denoise', enabled)).resolves.toMatchObject({
      ok: false, error: { message: 'Invalid denoise setting.' },
    });
    expect(session.setDenoiseEnabled).not.toHaveBeenCalled();
  });

  it('blocks denoise changes from untrusted senders', async () => {
    const { session, invoke } = setup({ trusted: false });
    await expect(invoke('realtime:set-denoise', true)).resolves.toMatchObject({ ok: false });
    expect(session.setDenoiseEnabled).not.toHaveBeenCalled();
  });
});
