import { join } from 'node:path';
import {
  BrowserWindow,
  app,
  dialog,
  ipcMain,
  net,
  protocol,
  session,
  systemPreferences,
} from 'electron';
import { createMicrophoneCapture, initializeAudioEngine } from './audio/audioEngine';
import { readEnvFile, resolveRealtimeSpeechConfig } from './config';
import { RealtimeTranslationSession } from './realtime/RealtimeTranslationSession';
import { createRealtimeApi } from './realtimeApi';
import { registerRealtimeIpc } from './realtimeIpc';
import { PACKAGED_RENDERER_URL, RENDERER_CUSTOM_SCHEME, handleRendererProtocol } from './rendererProtocol';
import {
  buildContentSecurityPolicy,
  denyAllPermissions,
  isTrustedIpcSender,
  isTrustedRendererUrl,
  lockNavigation,
  type TrustedUrlCheck,
} from './security';
import type { DesktopConfig, DesktopConfigArgumentPrefix, DesktopSnapshotChannel } from './shared/desktopApi';

const APP_TITLE = 'Tellus Realtime Translation';
const CONFIG_ARGUMENT_PREFIX: DesktopConfigArgumentPrefix = '--tellus-desktop-config=';
const SNAPSHOT_CHANNEL: DesktopSnapshotChannel = 'realtime:snapshot';
const STOP_ON_QUIT_TIMEOUT_MS = 3_000;

// Only an unpackaged build may load the Vite dev server. A packaged app always serves its bundled files.
const devServerUrl = app.isPackaged ? null : readDevServerUrl(process.env.TELLUS_DESKTOP_DEV_SERVER_URL);
const isTrusted: TrustedUrlCheck = (url) => isTrustedRendererUrl(url, devServerUrl);

let mainWindow: BrowserWindow | null = null;
let realtimeSession: RealtimeTranslationSession | null = null;
let stoppingBeforeQuit = false;

protocol.registerSchemesAsPrivileged([RENDERER_CUSTOM_SCHEME]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (stoppingBeforeQuit || !realtimeSession?.isActive()) return;
    // Stop the session so the conversation is ended on the server before the process exits.
    event.preventDefault();
    stoppingBeforeQuit = true;
    void Promise.race([
      realtimeSession.stop(),
      new Promise((resolve) => setTimeout(resolve, STOP_ON_QUIT_TIMEOUT_MS)),
    ]).finally(() => app.quit());
  });
  app.whenReady().then(startApp).catch((error: unknown) => {
    dialog.showErrorBox(APP_TITLE, error instanceof Error ? error.message : String(error));
    app.exit(1);
  });
}

function startApp(): void {
  // A packaged app reads only the runtime keys copied at build time (scripts/write-runtime-env.mjs).
  // Values already set in the process environment take precedence.
  const envFile = app.isPackaged ? join(__dirname, '../runtime.env') : join(app.getAppPath(), '.env');
  const config = resolveRealtimeSpeechConfig({ ...readEnvFile(envFile), ...process.env });
  const getAccessToken = () => resolveRealtimeSpeechConfig({ ...readEnvFile(envFile), ...process.env }).accessToken;
  const api = createRealtimeApi({
    httpBaseUrl: config.httpBaseUrl,
    get accessToken() { return getAccessToken(); },
  }, (url, init) => net.fetch(url, init));
  // REST and both WebSockets run here without an Origin header, like other native clients.
  realtimeSession = new RealtimeTranslationSession(
    { websocketBaseUrl: config.websocketBaseUrl },
    api,
    () => createMicrophoneCapture(requestMicrophoneAccess),
    getAccessToken,
  );
  realtimeSession.subscribe((snapshot) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(SNAPSHOT_CHANNEL, snapshot);
  });

  if (!devServerUrl) {
    handleRendererProtocol(protocol, join(__dirname, '../renderer'), buildContentSecurityPolicy());
  }
  denyAllPermissions(session.defaultSession);
  registerRealtimeIpc({
    ipcMain,
    session: realtimeSession,
    isTrustedSender: (event) => isTrustedIpcSender(event, isTrusted),
  });
  mainWindow = createMainWindow({ accessTokenConfigured: Boolean(config.accessToken) });
  // Load the native engine and its models in the background so the first Start is fast.
  // A failure here is reported again when the user presses Start.
  initializeAudioEngine().then(
    (engine) => {
      const status = engine.getStatus();
      console.log(`[audio-engine] Ready: ${status.processingSampleRate} Hz, Silero VAD ${status.vad.ready ? 'loaded' : 'not loaded'}`);
    },
    (error: unknown) => console.error('[audio-engine] Initialization failed:', error),
  );
}

function createMainWindow(desktopConfig: DesktopConfig): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 720,
    minHeight: 560,
    title: APP_TITLE,
    backgroundColor: '#f4f6f8',
    show: false,
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: [`${CONFIG_ARGUMENT_PREFIX}${encodeURIComponent(JSON.stringify(desktopConfig))}`],
    },
  });

  lockNavigation(window.webContents, isTrusted);
  window.once('ready-to-show', () => window.show());
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  void window.loadURL(devServerUrl ?? PACKAGED_RENDERER_URL);
  return window;
}

function requestMicrophoneAccess(): Promise<boolean> {
  // macOS keeps its own microphone consent (TCC) for the app bundle that hosts the native engine.
  return process.platform === 'darwin'
    ? systemPreferences.askForMediaAccess('microphone')
    : Promise.resolve(true);
}

function readDevServerUrl(value: string | undefined): string | null {
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) {
    throw new Error(`TELLUS_DESKTOP_DEV_SERVER_URL must be a local http URL: ${value}`);
  }
  return url.href;
}
