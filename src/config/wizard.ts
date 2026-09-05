import crypto from "node:crypto";
import http from "node:http";
import { SETUP_TIMEOUT_MS } from "../constants.js";
import { browserCacheDir } from "../paths.js";
import { log } from "../logger.js";
import type { DiscoveryService } from "../discovery.js";
import type { Browser } from "playwright";
import type { TenantProfile } from "../types.js";
import type { ProfileVault } from "./vault.js";
import { parseTenantProfile } from "./profile.js";
import { WIZARD_CSS, WIZARD_HTML, WIZARD_JS } from "../ui/wizardPage.js";

function send(response: http.ServerResponse, status: number, type: string, body: string): void {
  response.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  });
  response.end(body);
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 256 * 1024) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function launchSetupBrowser(): Promise<Browser> {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= browserCacheDir();
  const { chromium } = await import("playwright");
  return chromium.launch({ headless: false });
}

export class ProfileWizard {
  private pending: Promise<TenantProfile> | null = null;
  constructor(
    private readonly discovery: DiscoveryService,
    private readonly vault: ProfileVault,
    private readonly launchBrowser = launchSetupBrowser,
    private readonly timeoutMs = SETUP_TIMEOUT_MS,
  ) {}

  open(): Promise<TenantProfile> {
    if (!this.pending) {
      this.pending = this.run().finally(() => { this.pending = null; });
    }
    return this.pending;
  }

  private async run(): Promise<TenantProfile> {
    const nonce = crypto.randomBytes(24).toString("base64url");
    const discoveredWarehouses = await this.discovery.warehouses();
    const existingProfile = await this.vault.load();
    let resolveSaved!: (profile: TenantProfile) => void;
    let rejectSaved!: (error: Error) => void;
    const saved = new Promise<TenantProfile>((resolve, reject) => { resolveSaved = resolve; rejectSaved = reject; });
    // Timeouts / a closed browser can occur before navigation has finished.
    void saved.catch(() => undefined);
    let rejectStopped!: (error: Error) => void;
    const stopped = new Promise<never>((_resolve, reject) => { rejectStopped = reject; });
    void stopped.catch(() => undefined);
    const stop = (error: Error) => { rejectSaved(error); rejectStopped(error); };
    let disposed = false;
    let saving = false;
    let completed = false;
    let saveTask: Promise<void> | undefined;
    const server = http.createServer(async (request, response) => {
      try {
        const host = request.headers.host ?? "";
        if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return send(response, 403, "text/plain", "Forbidden");
        const url = new URL(request.url ?? "/", `http://${host}`);
        if (url.pathname === "/" && url.searchParams.get("nonce") === nonce) return send(response, 200, "text/html; charset=utf-8", WIZARD_HTML);
        if (url.pathname === "/style.css") return send(response, 200, "text/css; charset=utf-8", WIZARD_CSS);
        if (url.pathname === "/app.js") return send(response, 200, "text/javascript; charset=utf-8", WIZARD_JS);
        if (request.headers["x-setup-nonce"] !== nonce) return send(response, 403, "application/json", JSON.stringify({ error: "Invalid setup session" }));
        if (url.pathname === "/api/discovery" && request.method === "GET") {
          return send(response, 200, "application/json", JSON.stringify({ warehouses: discoveredWarehouses, profile: existingProfile }));
        }
        if (url.pathname === "/api/save" && request.method === "POST") {
          if (saving || completed) return send(response, 409, "application/json", JSON.stringify({ error: "A save is already in progress or complete" }));
          saving = true;
          saveTask = (async () => {
            const parsed = parseTenantProfile(await readJson(request));
            if (disposed) throw new Error("Setup closed");
            const current = await this.vault.load();
            if (disposed) throw new Error("Setup closed");
            const profile = { ...current, ...parsed, aliases: current?.aliases ?? [] };
            await this.vault.save(profile);
            completed = true;
            send(response, 200, "application/json", JSON.stringify({ saved: true }));
            resolveSaved(profile);
          })();
          try { await saveTask; } finally { saving = false; }
          return;
        }
        send(response, 404, "text/plain", "Not found");
      } catch {
        send(response, 400, "application/json", JSON.stringify({ error: "Configuration could not be saved. Check the fields and local storage, then retry." }));
      }
    });

    let browser: Browser | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Failed to bind setup server");
      timeout = setTimeout(() => stop(new Error("Profile setup timed out")), this.timeoutMs);
      const launching = this.launchBrowser().then(async (launched) => {
        if (disposed) { await launched.close().catch(() => undefined); throw new Error("Setup closed"); }
        browser = launched;
        return launched;
      });
      browser = await Promise.race([launching, stopped]);
      browser.once("disconnected", () => { if (!completed) stop(new Error("Profile setup browser was closed")); });
      const context = await Promise.race([browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" }), stopped]);
      const page = await Promise.race([context.newPage(), stopped]);
      page.once("close", () => { if (!completed) stop(new Error("Profile setup window was closed")); });
      await Promise.race([page.goto(`http://127.0.0.1:${address.port}/?nonce=${encodeURIComponent(nonce)}`), stopped]);
      log("profile_wizard_opened");
      return await saved;
    } finally {
      disposed = true;
      clearTimeout(timeout);
      server.closeAllConnections();
      await saveTask?.catch(() => undefined);
      await browser?.close().catch(() => undefined);
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
}
