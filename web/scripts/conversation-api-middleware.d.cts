import type { IncomingMessage, ServerResponse } from 'node:http';

export const CONVERSATION_API_PREFIX: string;

export function createConversationApiMiddleware(options: {
  /** The API key from the Tellus API Console. It is used here only and never sent to the page. */
  apiKey: string;
  /** The Tellus HTTP base URL that the calls are forwarded to. */
  httpBaseUrl: string;
  timeoutMs?: number;
}): (request: IncomingMessage, response: ServerResponse, next: () => void) => void;
