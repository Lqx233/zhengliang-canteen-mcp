import fs from "node:fs/promises";
import { browserCacheDir } from "../paths.js";

export async function doctor(): Promise<void> {
  process.env.PLAYWRIGHT_BROWSERS_PATH ??= browserCacheDir();
  const { chromium } = await import("playwright");
  const executable = chromium.executablePath();
  let browserInstalled = true;
  try { await fs.access(executable); } catch { browserInstalled = false; }
  const result = {
    node: process.version,
    platform: process.platform,
    supportedPlatform: ["darwin", "win32"].includes(process.platform),
    browserCache: browserCacheDir(),
    browserExecutable: executable,
    browserInstalled,
  };
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.supportedPlatform || !browserInstalled) process.exitCode = 1;
}
