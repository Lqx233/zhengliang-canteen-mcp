import { BASE_URL } from "./constants.js";
import type { ApiResponse, RequestOptions } from "./types.js";

const RATE_STATUS = "9999";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isAuthFailure(response: ApiResponse<any>): boolean {
  const status = String(response.json?.status ?? "");
  const info = String(response.json?.info ?? "");
  return response.httpStatus === 401 || ["2011", "2003", "2004"].includes(status) || /token/i.test(info);
}

export class ApiClient {
  async request(pathname: string, options: RequestOptions = {}): Promise<ApiResponse<any>> {
    if (!pathname.startsWith("/")) throw new Error("API paths must be absolute relative paths");
    const url = new URL(pathname, BASE_URL);
    if (url.origin !== BASE_URL) throw new Error("Refusing to send credentials outside the configured API origin");
    const method = options.method ?? "GET";
    const headers: Record<string, string> = { Accept: "application/json" };
    if (options.body !== undefined) headers["Content-Type"] = "application/json; charset=utf-8";
    if (options.token) headers["Admin-Authorization"] = options.token;
    const response = await fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: "error",
    });
    const text = await response.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = { status: "parse_error", info: text.slice(0, 300) };
    }
    return { httpStatus: response.status, json };
  }

  async requestWithRetry(pathname: string, options: RequestOptions = {}): Promise<ApiResponse<any>> {
    let delay = 800;
    let last: ApiResponse<any> | null = null;
    for (let attempt = 0; attempt <= 5; attempt += 1) {
      last = await this.request(pathname, options);
      if (String(last.json?.status) !== RATE_STATUS && !String(last.json?.info ?? "").includes("操作太频繁")) {
        return last;
      }
      if (attempt < 5) await sleep(delay);
      delay = Math.min(10_000, Math.round(delay * 1.8));
    }
    return last!;
  }
}
