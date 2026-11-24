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

// The renderer learns only whether an example API server is configured. The API key is not in the app at all.
export const tellusDesktop = readTellusDesktop();
export const realtimeSpeechConfig = tellusDesktop.config;
