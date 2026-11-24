import type { IssuedAccessToken } from '../realtimeApi';

// A token this close to its expiry is replaced, so that a connection that is slow to open still
// reaches the server in time.
const REFRESH_BEFORE_EXPIRY_MS = 60_000;

/**
 * The access tokens of one Conversation, issued through the example server. A token opens any
 * number of connections to its Conversation until it expires, so one is reused for both
 * WebSockets and for the engine approval on `/v1/audio`. An open WebSocket is not closed when its
 * token expires.
 */
export class ConversationAccessTokens {
  private issued: IssuedAccessToken | null = null;
  private issuing: Promise<string> | null = null;

  constructor(private readonly issue: () => Promise<IssuedAccessToken>) {}

  /** A token that is valid for at least another minute. */
  get(): Promise<string> {
    if (this.issued && this.issued.expiresAtMs - Date.now() > REFRESH_BEFORE_EXPIRY_MS) {
      return Promise.resolve(this.issued.token);
    }
    // Callers that ask while a token is being issued share that one.
    this.issuing ??= this.issue()
      .then((issued) => {
        this.issued = issued;
        return issued.token;
      })
      .finally(() => {
        this.issuing = null;
      });
    return this.issuing;
  }
}
