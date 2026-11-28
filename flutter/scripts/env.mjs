import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';

/** This example's settings: `.env`, with the process environment taking precedence. */
export function readEnv() {
  const file = new URL('../.env', import.meta.url);
  return { ...(existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {}), ...process.env };
}

/** The development server's port. The app's default server address (dart-defines.mjs) uses it too. */
export function serverPort(env) {
  const port = Number(env.TELLUS_EXAMPLE_SERVER_PORT?.trim() || 8787);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('TELLUS_EXAMPLE_SERVER_PORT must be a port number between 1 and 65535.');
  }
  return port;
}
