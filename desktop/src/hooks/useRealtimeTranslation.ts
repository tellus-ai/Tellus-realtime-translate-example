import { useCallback, useSyncExternalStore } from 'react';
import { tellusDesktop } from '../config/realtimeSpeechConfig';
import type { DesktopResult, StartConversationInput } from '../../electron/shared/desktopApi';
import type { SessionSnapshot } from '../../electron/shared/realtimeTypes';

// The session runs in the Electron main process. The renderer mirrors the snapshots it pushes,
// so a reload reattaches to a session that is still running.
const INITIAL_SNAPSHOT: SessionSnapshot = {
  phase: 'idle',
  conversationId: null,
  resultConnection: 'closed',
  audioConnection: 'closed',
  rows: [],
  audioSdkReady: false,
  vad: { enabled: false, ready: false, mode: 'disabled', gate: 'open', isSpeech: false, probability: 0, level: 'off' },
  error: null,
};

let currentSnapshot = INITIAL_SNAPSHOT;
let receivedPush = false;
const listeners = new Set<() => void>();

function publish(snapshot: SessionSnapshot): void {
  currentSnapshot = snapshot;
  listeners.forEach((listener) => listener());
}

tellusDesktop.onSnapshot((snapshot) => {
  receivedPush = true;
  publish(snapshot);
});
void tellusDesktop.getSnapshot().then((result) => {
  // A pushed snapshot is newer than the one requested at load time.
  if (result.ok && !receivedPush) publish(result.data);
});

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function unwrap(request: Promise<DesktopResult<null>>): Promise<void> {
  const result = await request;
  if (!result.ok) throw new Error(result.error.message);
}

export function useRealtimeTranslation() {
  const snapshot = useSyncExternalStore(subscribe, () => currentSnapshot);

  return {
    ...snapshot,
    start: useCallback((input: StartConversationInput) => unwrap(tellusDesktop.start(input)), []),
    pause: useCallback(() => unwrap(tellusDesktop.pause()), []),
    resume: useCallback(() => unwrap(tellusDesktop.resume()), []),
    stop: useCallback(() => unwrap(tellusDesktop.stop()), []),
  };
}
