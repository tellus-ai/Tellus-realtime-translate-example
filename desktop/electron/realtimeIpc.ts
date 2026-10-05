import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { RealtimeTranslationSession } from './realtime/RealtimeTranslationSession';
import { toDesktopError } from './realtimeApi';
import type { DesktopIpcChannel, DesktopResult, StartConversationInput } from './shared/desktopApi';

const LANGUAGE_TAG = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;

export interface RealtimeIpcOptions {
  ipcMain: Pick<IpcMain, 'handle'>;
  session: Pick<RealtimeTranslationSession, 'getSnapshot' | 'start' | 'pause' | 'resume' | 'stop'>;
  isTrustedSender(event: IpcMainInvokeEvent): boolean;
}

export function registerRealtimeIpc({ ipcMain, session, isTrustedSender }: RealtimeIpcOptions): void {
  const handle = <T>(channel: DesktopIpcChannel, handler: (...args: unknown[]) => Promise<T> | T) => {
    ipcMain.handle(channel, async (event, ...args): Promise<DesktopResult<T>> => {
      try {
        if (!isTrustedSender(event)) throw new Error(`Blocked IPC from an untrusted sender: ${channel}`);
        return { ok: true, data: await handler(...args) };
      } catch (error) {
        return { ok: false, error: toDesktopError(error) };
      }
    });
  };

  handle('realtime:get-snapshot', () => session.getSnapshot());
  handle('realtime:start', async (input) => {
    await session.start(readStartConversationInput(input));
    return null;
  });
  handle('realtime:pause', async () => {
    await session.pause();
    return null;
  });
  handle('realtime:resume', async () => {
    await session.resume();
    return null;
  });
  handle('realtime:stop', async () => {
    await session.stop();
    return null;
  });
}

function readStartConversationInput(value: unknown): StartConversationInput {
  if (typeof value !== 'object' || value === null) throw new Error('Invalid interpretation settings.');
  const { sourceLanguage, targetLanguage, clientVad } = value as Record<string, unknown>;
  if (!isLanguageTag(sourceLanguage) || !isLanguageTag(targetLanguage) || typeof clientVad !== 'boolean') {
    throw new Error('Invalid interpretation settings.');
  }
  return { sourceLanguage, targetLanguage, clientVad };
}

function isLanguageTag(value: unknown): value is string {
  return typeof value === 'string' && LANGUAGE_TAG.test(value);
}
