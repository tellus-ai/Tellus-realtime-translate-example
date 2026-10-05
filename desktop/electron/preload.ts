import { contextBridge, ipcRenderer } from 'electron';
import type {
  DesktopConfig,
  DesktopConfigArgumentPrefix,
  DesktopIpcChannel,
  DesktopResult,
  DesktopSnapshotChannel,
  TellusDesktopApi,
} from './shared/desktopApi';
import type { SessionSnapshot } from './shared/realtimeTypes';

// A sandboxed preload can only require built-in modules, so this file imports types only.
const CONFIG_ARGUMENT_PREFIX: DesktopConfigArgumentPrefix = '--tellus-desktop-config=';
const SNAPSHOT_CHANNEL: DesktopSnapshotChannel = 'realtime:snapshot';

function readConfig(): DesktopConfig {
  const argument = process.argv.find((value) => value.startsWith(CONFIG_ARGUMENT_PREFIX));
  if (!argument) throw new Error('The desktop config argument is missing.');
  return JSON.parse(decodeURIComponent(argument.slice(CONFIG_ARGUMENT_PREFIX.length))) as DesktopConfig;
}

function invoke<T>(channel: DesktopIpcChannel, ...args: unknown[]): Promise<DesktopResult<T>> {
  return ipcRenderer.invoke(channel, ...args);
}

const tellusDesktop: TellusDesktopApi = {
  config: readConfig(),
  getSnapshot: () => invoke('realtime:get-snapshot'),
  onSnapshot: (listener) => {
    // Pass only the snapshot; the IPC event object must not reach the page.
    const handler = (_event: Electron.IpcRendererEvent, snapshot: SessionSnapshot) => listener(snapshot);
    ipcRenderer.on(SNAPSHOT_CHANNEL, handler);
    return () => {
      ipcRenderer.removeListener(SNAPSHOT_CHANNEL, handler);
    };
  },
  start: (input) => invoke('realtime:start', input),
  pause: () => invoke('realtime:pause'),
  resume: () => invoke('realtime:resume'),
  stop: () => invoke('realtime:stop'),
};

contextBridge.exposeInMainWorld('tellusDesktop', tellusDesktop);
