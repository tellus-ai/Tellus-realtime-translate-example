import type { IncomingMessage, ServerResponse } from 'node:http';

export function createRecordingDownloadMiddleware(options?: { homeDirectory?: string }):
  (request: IncomingMessage, response: ServerResponse, next: () => void) => void;
