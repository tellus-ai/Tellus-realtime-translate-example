import type { IncomingMessage, ServerResponse } from 'node:http';

export function createRecordingDownloadMiddleware(options?: { homeDirectory?: string; allowedClients?: string | string[]; maxBytes?: number }):
  (request: IncomingMessage, response: ServerResponse, next: () => void) => void;
