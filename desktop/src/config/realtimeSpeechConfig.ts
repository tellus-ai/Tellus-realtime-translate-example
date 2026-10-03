import type { TellusDesktopApi } from '../../electron/shared/desktopApi';

declare global {
  interface Window {
    tellusDesktop?: TellusDesktopApi;
  }
}

function readTellusDesktop(): TellusDesktopApi {
  if (!window.tellusDesktop) {
    throw new Error('The Tellus desktop bridge is unavailable. Open this screen through the Electron app.');
  }
  return window.tellusDesktop;
}

// API_KEY and the server URLs stay in the main process; the renderer only learns whether a token is set.
export const tellusDesktop = readTellusDesktop();
export const realtimeSpeechConfig = tellusDesktop.config;
