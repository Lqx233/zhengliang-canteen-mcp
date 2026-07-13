import fs from "node:fs/promises";
import path from "node:path";
import { AUTH_TIMEOUT_MS, DEFAULT_PROFILE } from "../constants.js";
import { authLockPath } from "../paths.js";

export async function acquireAuthLock(profile = DEFAULT_PROFILE): Promise<() => Promise<void>> {
  const lockPath = authLockPath(profile);
  await fs.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + AUTH_TIMEOUT_MS;
  while (true) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
      await handle.close();
      return async () => {
        try {
          await fs.unlink(lockPath);
        } catch (error: any) {
          if (error?.code !== "ENOENT") throw error;
        }
      };
    } catch (error: any) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const stat = await fs.stat(lockPath);
        if (Date.now() - stat.mtimeMs > AUTH_TIMEOUT_MS + 60_000) {
          await fs.unlink(lockPath);
          continue;
        }
      } catch (statError: any) {
        if (statError?.code === "ENOENT") continue;
      }
      if (Date.now() >= deadline) throw new Error("Timed out waiting for another login window");
      await new Promise((resolve) => setTimeout(resolve, 750));
    }
  }
}
