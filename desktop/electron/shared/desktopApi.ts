// Type-only contract shared by main, preload, and renderer.
// The sandboxed preload cannot require local modules, so channel names are string literal
// types: main and preload repeat the literals and the compiler keeps them in sync.
import type { SessionSnapshot } from './realtimeTypes';

export type DesktopIpcChannel =
  | 'realtime:get-snapshot'
  | 'realtime:start'
  | 'realtime:pause'
  | 'realtime:resume'
  | 'realtime:stop';

/** Pushed from main to the renderer whenever the session snapshot changes. */
export type DesktopSnapshotChannel = 'realtime:snapshot';

export type DesktopConfigArgumentPrefix = '--tellus-desktop-config=';

export interface DesktopConfig {
  audioSdkEnabled: boolean;
  accessTokenConfigured: boolean;
}

export interface StartConversationInput {
  sourceLanguage: string;
  targetLanguage: string;
  clientVad: boolean;
}

export interface DesktopError {
  message: string;
  status: number | null;
  messages: string[];
}

export type DesktopResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: DesktopError };

export interface TellusDesktopApi {
  config: DesktopConfig;
  getSnapshot(): Promise<DesktopResult<SessionSnapshot>>;
  onSnapshot(listener: (snapshot: SessionSnapshot) => void): () => void;
  start(input: StartConversationInput): Promise<DesktopResult<null>>;
  pause(): Promise<DesktopResult<null>>;
  resume(): Promise<DesktopResult<null>>;
  stop(): Promise<DesktopResult<null>>;
}
