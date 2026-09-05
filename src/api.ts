import { setTimeout as wait } from "node:timers/promises";
import { BASE_URL } from "./constants.js";
import type { ApiResponse, RequestOptions } from "./types.js";

export const API_TIMEOUT_MS = 30_000;

export class RequestFailure extends Error {
  constructor(readonly writeUncertain: boolean, readonly timedOut: boolean) {
    super(writeUncertain
      ? "Write result is uncertain after a transport failure. Verify current state before retrying."
      : timedOut ? "API request timed out" : "API request was cancelled or could not be completed");
    this.name = "RequestFailure";
  }
}

export function isAuthFailure(response: ApiResponse<any>): boolean {
  return response.httpStatus === 401 || (response.httpStatus >= 200 && response.httpStatus < 300 && ["2011", "2003", "2004"].includes(String(response.json?.status)));
}

export function responseSucceeded(response: ApiResponse<any>): boolean {
  const json = response.json;
  return response.httpStatus >= 200 && response.httpStatus < 300 &&
    (json?.status !== undefined ? [0, "0"].includes(json.status) : json?.success === true);
}

export function requireResponse(response: ApiResponse<any>): void {
  if (!responseSucceeded(response)) throw new Error(`API response was not successful (HTTP ${response.httpStatus})`);
}

function timeoutValue(options: RequestOptions): number {
  const ms = options.timeoutMs ?? API_TIMEOUT_MS;
  if (!Number.isFinite(ms) || ms <= 0) throw new Error("Invalid API timeout");
  return ms;
}

export class ApiClient {
  async request(pathname: string, options: RequestOptions = {}): Promise<ApiResponse<any>> {
    if (!pathname.startsWith("/")) throw new Error("API paths must be absolute relative paths");
    const url = new URL(pathname, BASE_URL);
    if (url.origin !== BASE_URL) throw new Error("Refusing to send credentials outside the configured API origin");
    const method = options.method ?? "GET";
    const operation = options.operation ?? (method === "POST" ? "write" : "read");
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.body !== undefined) headers["Content-Type"] = "application/json; charset=utf-8";
    if (options.token) headers["Admin-Authorization"] = options.token;
    const deadline = AbortSignal.timeout(timeoutValue(options));
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    let sent = false;
    try {
      signal.throwIfAborted();
      const body = options.body === undefined ? undefined : JSON.stringify(options.body);
      sent = true;
      const response = await fetch(url, { method, headers, body, redirect: "error", signal });
      const text = await response.text();
      let json: any;
      try { json = JSON.parse(text); }
      catch {
        if (operation === "write") throw new RequestFailure(true, false);
        json = { status: "parse_error", info: "Upstream returned a non-JSON response" };
      }
      return { httpStatus: response.status, json };
    } catch {
      throw new RequestFailure(sent && operation === "write", deadline.aborted);
    }
  }

  async requestWithRetry(pathname: string, options: RequestOptions = {}): Promise<ApiResponse<any>> {
    const deadline = Date.now() + timeoutValue(options);
    let delay = 800;
    for (let attempt = 0; ; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0 || options.signal?.aborted) throw new RequestFailure(false, remaining <= 0);
      const response = await this.request(pathname, { ...options, timeoutMs: remaining });
      const rateLimited = response.httpStatus === 429 || String(response.json?.status) === "9999" || String(response.json?.info ?? "").includes("操作太频繁");
      // Only explicitly reviewed reads may be repeated (including read-only POSTs).
      if (options.operation !== "read" || !rateLimited || attempt >= 5) return response;
      const budget = deadline - Date.now();
      if (delay >= budget) throw new RequestFailure(false, true);
      try { await wait(delay, undefined, { signal: options.signal }); }
      catch { throw new RequestFailure(false, false); }
      delay = Math.min(10_000, Math.round(delay * 1.8));
    }
  }
}
