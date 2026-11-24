import type { IncomingMessage, ServerResponse } from 'node:http';

export const CONVERSATION_API_PREFIX: string;

export function createConversationApiMiddleware(options: {
  /** The API key from the Tellus API Console. It is used here only and never sent to the page. */
  apiKey: string;
  /** The Tellus HTTP base URL that the calls are forwarded to. */
  httpBaseUrl: string;
  /** Callers besides this computer, as addresses or TELLUS_EXAMPLE_API_CLIENTS (comma-separated). */
  allowedClients?: string | string[];
  /** Called once for each refused address. Logs a warning by default. */
  onRefusedClient?: (address: string) => void;
  timeoutMs?: number;
}): (request: IncomingMessage, response: ServerResponse, next: () => void) => void;
