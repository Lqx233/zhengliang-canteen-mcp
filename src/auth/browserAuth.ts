import { AUTH_STORAGE_KEY, AUTH_TIMEOUT_MS, BASE_URL, LOGIN_URL } from "../constants.js";
import { browserCacheDir } from "../paths.js";
import { log } from "../logger.js";

export interface BrowserAuthenticator {
  login(signal?: AbortSignal): Promise<string>;
}

export function extractToken(storageValue: string | null): string | null {
  if (!storageValue) return null;
  try {
    const parsed = JSON.parse(storageValue) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const token = (parsed as Record<string, unknown>).token;
    return typeof token === "string" && token.length >= 20 ? token : null;
  } catch {
    return null;
  }
}

export class OfficialBrowserAuthenticator implements BrowserAuthenticator {
  async login(signal?: AbortSignal): Promise<string> {
    process.env.PLAYWRIGHT_BROWSERS_PATH ??= browserCacheDir();
    const { chromium } = await import("playwright");
    log("browser_login_opened", { origin: BASE_URL });
    const browser = await chromium.launch({ headless: false });
    const close = () => { void browser.close().catch(() => undefined); };
    signal?.addEventListener("abort", close, { once: true });
    try {
      signal?.throwIfAborted();
      const context = await browser.newContext({
        acceptDownloads: false, viewport: { width: 1280, height: 820 }, locale: "zh-CN",
      });
      const page = await context.newPage();
      const deadline = Date.now() + AUTH_TIMEOUT_MS;
      await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        if (page.isClosed()) throw new Error("Login window was closed before authentication completed");
        if (new URL(page.url()).origin === BASE_URL) {
          const storage = await page.evaluate((key) => sessionStorage.getItem(key), AUTH_STORAGE_KEY);
          const token = extractToken(storage);
          if (token) { log("browser_login_token_captured"); return token; }
        }
        await page.waitForTimeout(400);
      }
      throw new Error("Browser login timed out");
    } finally {
      signal?.removeEventListener("abort", close);
      await browser.close().catch(() => undefined);
    }
  }
}
