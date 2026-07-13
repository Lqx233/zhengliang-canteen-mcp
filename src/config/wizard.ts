import crypto from "node:crypto";
import http from "node:http";
import { SETUP_TIMEOUT_MS } from "../constants.js";
import { browserCacheDir } from "../paths.js";
import { log } from "../logger.js";
import type { DiscoveryService } from "../discovery.js";
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

export class ProfileWizard {
  constructor(private readonly discovery: DiscoveryService, private readonly vault: ProfileVault) {}

  async open(): Promise<TenantProfile> {
    const nonce = crypto.randomBytes(24).toString("base64url");
    const discoveredWarehouses = await this.discovery.warehouses();
    let resolveSaved!: (profile: TenantProfile) => void;
    let rejectSaved!: (error: Error) => void;
    const saved = new Promise<TenantProfile>((resolve, reject) => { resolveSaved = resolve; rejectSaved = reject; });

    const server = http.createServer(async (request, response) => {
      try {
        const host = request.headers.host ?? "";
        if (!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return send(response, 403, "text/plain", "Forbidden");
        const url = new URL(request.url ?? "/", `http://${host}`);
        const headerNonce = request.headers["x-setup-nonce"];
        if (url.pathname === "/" && url.searchParams.get("nonce") === nonce) return send(response, 200, "text/html; charset=utf-8", WIZARD_HTML);
        if (url.pathname === "/style.css") return send(response, 200, "text/css; charset=utf-8", WIZARD_CSS);
        if (url.pathname === "/app.js") return send(response, 200, "text/javascript; charset=utf-8", WIZARD_JS);
        if (headerNonce !== nonce) return send(response, 403, "application/json", JSON.stringify({ error: "Invalid setup session" }));
        if (url.pathname === "/api/discovery" && request.method === "GET") {
          return send(response, 200, "application/json", JSON.stringify({ warehouses: discoveredWarehouses }));
        }
        if (url.pathname === "/api/save" && request.method === "POST") {
          const profile = parseTenantProfile(await readJson(request));
          await this.vault.save(profile);
          send(response, 200, "application/json", JSON.stringify({ saved: true }));
          resolveSaved(profile);
          return;
        }
        send(response, 404, "text/plain", "Not found");
      } catch (error: any) {
        send(response, 400, "application/json", JSON.stringify({ error: error?.message ?? "Invalid configuration" }));
      }
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Failed to bind setup server");
    process.env.PLAYWRIGHT_BROWSERS_PATH ??= browserCacheDir();
    const { chromium } = await import("playwright");
    const browser = await chromium.launch({ headless: false });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: "zh-CN" });
    const page = await context.newPage();
    const timeout = setTimeout(() => rejectSaved(new Error("Profile setup timed out")), SETUP_TIMEOUT_MS);
    try {
      await page.goto(`http://127.0.0.1:${address.port}/?nonce=${encodeURIComponent(nonce)}`);
      log("profile_wizard_opened");
      const profile = await saved;
      await page.waitForTimeout(800);
      return profile;
    } finally {
      clearTimeout(timeout);
      server.close();
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    }
  }
}
