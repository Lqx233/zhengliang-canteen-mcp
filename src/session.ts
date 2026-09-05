import { ApiClient, isAuthFailure, requireResponse } from "./api.js";
import { acquireAuthLock } from "./auth/lock.js";
import type { BrowserAuthenticator } from "./auth/browserAuth.js";
import { TokenStorageError, type SecretStore } from "./auth/tokenStore.js";
import { DEFAULT_PROFILE } from "./constants.js";
import { log } from "./logger.js";
import type { ApiResponse, RequestOptions } from "./types.js";

export class WriteReplayRequiredError extends Error {
  constructor() {
    super("Authentication was renewed; the write was not replayed. Verify current state before retrying.");
    this.name = "WriteReplayRequiredError";
  }
}

export class AuthenticationChangedError extends Error {
  constructor() {
    super("Authentication changed or was cancelled; prepare the operation again.");
    this.name = "AuthenticationChangedError";
  }
}

function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new AuthenticationChangedError());
    if (signal.aborted) { pending.catch(() => undefined); abort(); return; }
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export class Session {
  private token: string | null = null;
  private authPromise: Promise<string> | null = null;
  private storageFailure: TokenStorageError | null = null;
  private controller = new AbortController();
  private epoch = 0;
  private authRevision = 0;
  private logoutPromise: Promise<void> | null = null;

  constructor(
    private readonly secrets: SecretStore,
    private readonly browserAuth: BrowserAuthenticator,
    private readonly api = new ApiClient(),
    private readonly profile = DEFAULT_PROFILE,
  ) {}

  get revision(): number { return this.authRevision; }

  assertRevision(expected: number): void {
    if (expected !== this.authRevision || this.controller.signal.aborted) throw new AuthenticationChangedError();
  }

  bootstrap(): void {
    void this.ensureToken().catch((error) => log("auth_bootstrap_failed", { errorType: error?.name ?? "Error" }));
  }

  async status(): Promise<{ authenticated: boolean; profile: string }> {
    if (this.storageFailure) throw this.storageFailure;
    if (this.logoutPromise || this.authPromise) return { authenticated: false, profile: this.profile };
    if (this.token) return { authenticated: true, profile: this.profile };
    const epoch = this.epoch;
    const stored = await this.secrets.getToken(this.profile);
    if (!stored) return { authenticated: false, profile: this.profile };
    const response = await this.api.request("/auth/groups/getUserGroupAuth", { token: stored, operation: "read" });
    if (epoch !== this.epoch) throw new AuthenticationChangedError();
    if (isAuthFailure(response)) return { authenticated: false, profile: this.profile };
    requireResponse(response);
    return { authenticated: true, profile: this.profile };
  }

  async ensureToken(force = false): Promise<string> {
    if (this.logoutPromise) await this.logoutPromise;
    if (!force && this.storageFailure) throw this.storageFailure;
    if (this.authPromise) return this.authPromise;
    if (!force && this.token) return this.token;
    return this.startAuthentication(force);
  }

  private startAuthentication(force: boolean, failedToken?: string): Promise<string> {
    if (this.authPromise) return this.authPromise;
    if (force || failedToken) {
      this.authRevision++;
      this.token = null;
    }
    if (force) this.storageFailure = null;
    this.controller.abort();
    this.controller = new AbortController();
    const signal = this.controller.signal;
    const epoch = ++this.epoch;
    const pending = this.authenticate(force, signal, failedToken).catch((error: unknown) => {
      if (epoch === this.epoch && error instanceof TokenStorageError) {
        this.storageFailure = error;
        this.token = null;
      }
      throw error;
    }).finally(() => {
      if (this.authPromise === pending) this.authPromise = null;
    });
    this.authPromise = pending;
    return pending;
  }

  private async authenticate(force: boolean, signal: AbortSignal, failedToken?: string): Promise<string> {
    const release = await acquireAuthLock(this.profile, signal);
    const check = () => { if (signal.aborted) throw new AuthenticationChangedError(); };
    try {
      check();
      if (!force) {
        const stored = await this.secrets.getToken(this.profile);
        check();
        if (stored && stored !== failedToken) {
          const validation = await abortable(this.api.request("/auth/groups/getUserGroupAuth", { token: stored, operation: "read", signal }), signal);
          check();
          if (!isAuthFailure(validation)) {
            requireResponse(validation);
            this.token = stored;
            this.authRevision++;
            log("stored_token_accepted");
            return stored;
          }
        }
        if (stored) await this.secrets.deleteToken(this.profile);
      }
      check();
      const token = await abortable(this.browserAuth.login(signal), signal);
      check();
      const validation = await abortable(this.api.request("/auth/groups/getUserGroupAuth", { token, operation: "read", signal }), signal);
      check();
      requireResponse(validation);
      await this.secrets.setToken(token, this.profile);
      check();
      this.token = token;
      this.authRevision++;
      log("new_token_stored");
      return token;
    } finally {
      await release();
    }
  }

  async logout(): Promise<void> {
    if (this.logoutPromise) return this.logoutPromise;
    this.epoch++;
    this.authRevision++;
    this.controller.abort();
    this.token = null;
    const pending = (async () => {
      const release = await acquireAuthLock(this.profile);
      try {
        await this.secrets.deleteToken(this.profile);
        this.storageFailure = null;
        log("token_deleted");
      } catch (error) {
        if (error instanceof TokenStorageError) this.storageFailure = error;
        throw error;
      } finally { await release(); }
    })().finally(() => { if (this.logoutPromise === pending) this.logoutPromise = null; });
    this.logoutPromise = pending;
    return pending;
  }

  async call(pathname: string, options: RequestOptions = {}): Promise<ApiResponse<any>> {
    const operation = options.operation ?? (options.method === "POST" ? "write" : "read");
    const token = await this.ensureToken();
    if (options.expectedAuthRevision !== undefined) this.assertRevision(options.expectedAuthRevision);
    const revision = this.authRevision;
    const response = await this.api.requestWithRetry(pathname, { ...options, operation, token });
    if (!isAuthFailure(response)) { requireResponse(response); return response; }
    if (this.storageFailure) throw this.storageFailure;
    if (this.controller.signal.aborted || this.logoutPromise) throw new AuthenticationChangedError();
    if (options.expectedAuthRevision !== undefined) throw new AuthenticationChangedError();
    // A late response can reuse a newer token; it must never delete that token.
    let renewed: string;
    if (this.token && this.token !== token) renewed = this.token;
    else if (this.authPromise) renewed = await this.authPromise;
    else {
      if (revision !== this.authRevision) throw new AuthenticationChangedError();
      renewed = await this.startAuthentication(false, token);
    }
    if (operation === "write") throw new WriteReplayRequiredError();
    const retried = await this.api.requestWithRetry(pathname, { ...options, operation, token: renewed });
    requireResponse(retried);
    return retried;
  }
}
