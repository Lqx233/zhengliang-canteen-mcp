import { ApiClient, isAuthFailure } from "./api.js";
import { acquireAuthLock } from "./auth/lock.js";
import type { BrowserAuthenticator } from "./auth/browserAuth.js";
import type { SecretStore } from "./auth/tokenStore.js";
import { DEFAULT_PROFILE } from "./constants.js";
import { log } from "./logger.js";
import type { ApiResponse, RequestOptions } from "./types.js";

export class WriteReplayRequiredError extends Error {
  constructor() {
    super("Authentication was renewed; the write was not replayed. Verify current state before retrying.");
    this.name = "WriteReplayRequiredError";
  }
}

export class Session {
  private token: string | null = null;
  private authPromise: Promise<string> | null = null;

  constructor(
    private readonly secrets: SecretStore,
    private readonly browserAuth: BrowserAuthenticator,
    private readonly api = new ApiClient(),
    private readonly profile = DEFAULT_PROFILE,
  ) {}

  bootstrap(): void {
    void this.ensureToken().catch((error) => log("auth_bootstrap_failed", { errorType: error?.name ?? "Error" }));
  }

  async status(): Promise<{ authenticated: boolean; profile: string }> {
    const token = this.token ?? await this.secrets.getToken(this.profile);
    return { authenticated: Boolean(token), profile: this.profile };
  }

  async ensureToken(force = false): Promise<string> {
    if (!force && this.token) return this.token;
    if (!this.authPromise) {
      this.authPromise = this.authenticate(force).finally(() => {
        this.authPromise = null;
      });
    }
    return this.authPromise;
  }

  private async authenticate(force: boolean): Promise<string> {
    if (!force) {
      const stored = await this.secrets.getToken(this.profile);
      if (stored) {
        const validation = await this.api.request("/auth/groups/getUserGroupAuth", { token: stored });
        if (!isAuthFailure(validation)) {
          this.token = stored;
          log("stored_token_accepted");
          return stored;
        }
        await this.secrets.deleteToken(this.profile);
      }
    }

    const release = await acquireAuthLock(this.profile);
    try {
      if (!force) {
        const tokenFromOtherProcess = await this.secrets.getToken(this.profile);
        if (tokenFromOtherProcess) {
          this.token = tokenFromOtherProcess;
          return tokenFromOtherProcess;
        }
      }
      const token = await this.browserAuth.login();
      const validation = await this.api.request("/auth/groups/getUserGroupAuth", { token });
      if (isAuthFailure(validation)) throw new Error("The captured browser session was rejected by the API");
      await this.secrets.setToken(token, this.profile);
      this.token = token;
      log("new_token_stored");
      return token;
    } finally {
      await release();
    }
  }

  async logout(): Promise<void> {
    this.token = null;
    await this.secrets.deleteToken(this.profile);
    log("token_deleted");
  }

  async call(pathname: string, options: RequestOptions = {}): Promise<ApiResponse<any>> {
    const operation = options.operation ?? (options.method === "POST" ? "write" : "read");
    const token = await this.ensureToken();
    let response = await this.api.requestWithRetry(pathname, { ...options, token });
    if (!isAuthFailure(response)) return response;

    this.token = null;
    await this.secrets.deleteToken(this.profile);
    const renewed = await this.ensureToken(true);
    if (operation === "write") throw new WriteReplayRequiredError();
    response = await this.api.requestWithRetry(pathname, { ...options, token: renewed });
    return response;
  }
}
