import type { IpcMainInvokeEvent, Session, WebContents } from 'electron';
import { RENDERER_HOST, RENDERER_SCHEME } from './rendererProtocol';

export type TrustedUrlCheck = (url: string) => boolean;

export function isTrustedRendererUrl(url: string, devServerUrl: string | null): boolean {
  try {
    const parsed = new URL(url);
    if (devServerUrl) return parsed.origin === new URL(devServerUrl).origin;
    return parsed.protocol === `${RENDERER_SCHEME}:` && parsed.host === RENDERER_HOST;
  } catch {
    return false;
  }
}

export function isTrustedIpcSender(event: IpcMainInvokeEvent, isTrusted: TrustedUrlCheck): boolean {
  const frame = event.senderFrame;
  return frame !== null && frame === event.sender.mainFrame && isTrusted(frame.url);
}

// The renderer only draws the session state; it has no reason to reach the network.
export function buildContentSecurityPolicy(): string {
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; ');
}

/**
 * Electron grants every permission by default. The microphone is captured by the native audio
 * engine in the main process, so the renderer needs no permission at all.
 */
export function denyAllPermissions(session: Session): void {
  session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  session.setPermissionCheckHandler(() => false);
}

export function lockNavigation(webContents: WebContents, isTrusted: TrustedUrlCheck): void {
  const blockUntrusted = (event: Electron.Event<{ url: string }>) => {
    if (!isTrusted(event.url)) event.preventDefault();
  };
  webContents.on('will-navigate', blockUntrusted);
  webContents.on('will-redirect', blockUntrusted);
  webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}
