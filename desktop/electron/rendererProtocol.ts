import { readFile } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { CustomScheme, Protocol } from 'electron';

// The packaged renderer is served from a standard, secure scheme instead of file:// so it gets a
// real origin that navigation checks and the CSP can pin. The renderer never talks to the server:
// REST and both WebSockets run in the main process, so this origin is not on any server allowlist.
// The scheme only exists inside this app's Electron session; it is not registered with the OS.
export const RENDERER_SCHEME = 'tellus-translate';
export const RENDERER_HOST = 'app';
export const PACKAGED_RENDERER_URL = `${RENDERER_SCHEME}://${RENDERER_HOST}/index.html`;

export const RENDERER_CUSTOM_SCHEME: CustomScheme = {
  scheme: RENDERER_SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true },
};

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

export function resolveRendererFile(requestUrl: string, rendererRoot: string): string | null {
  let url: URL;
  let pathname: string;
  try {
    url = new URL(requestUrl);
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  if (url.protocol !== `${RENDERER_SCHEME}:` || url.host !== RENDERER_HOST || pathname.includes('\0')) {
    return null;
  }

  const filePath = resolve(rendererRoot, pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, ''));
  const fromRoot = relative(rendererRoot, filePath);
  if (!fromRoot || fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    return null;
  }
  return filePath;
}

export function handleRendererProtocol(
  protocol: Pick<Protocol, 'handle'>,
  rendererRoot: string,
  contentSecurityPolicy: string,
): void {
  protocol.handle(RENDERER_SCHEME, async (request) => {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } });
    }
    const filePath = resolveRendererFile(request.url, rendererRoot);
    let body: Buffer;
    try {
      if (!filePath) throw new Error('Not found');
      body = await readFile(filePath);
    } catch {
      return new Response('Not Found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }

    const headers = new Headers({
      'Content-Type': CONTENT_TYPES[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
    });
    if (filePath.endsWith('.html')) headers.set('Content-Security-Policy', contentSecurityPolicy);
    return new Response(request.method === 'HEAD' ? null : new Uint8Array(body), { status: 200, headers });
  });
}
