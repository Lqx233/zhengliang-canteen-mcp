import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { AUTH_TIMEOUT_MS, DEFAULT_PROFILE } from "../constants.js";
import { appDataDir } from "../paths.js";

export async function acquireStorageLock(profile: string, purpose: string, signal?: AbortSignal, timeoutMs = 30_000): Promise<() => Promise<void>> {
  const id = crypto.createHash("sha256").update(JSON.stringify([profile, purpose])).digest("hex");
  const directory = path.join(appDataDir(), "locks", `${id}.lockdir`);
  await fs.mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
  const owner = `${process.pid}-${crypto.randomUUID()}.owner`;
  const ownerPath = path.join(directory, owner);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    signal?.throwIfAborted();
    let acquired = false;
    try { await fs.mkdir(directory, { mode: 0o700 }); acquired = true; }
    catch (error: any) { if (error?.code !== "EEXIST") throw error; }
    if (acquired) {
      try { await fs.writeFile(ownerPath, "", { mode: 0o600, flag: "wx" }); }
      catch (error) { await fs.rmdir(directory).catch(() => undefined); throw error; }
      return async () => {
        // Only the owner that successfully removes its unique marker may remove the directory.
        try { await fs.unlink(ownerPath); }
        catch (error: any) { if (error?.code === "ENOENT") return; throw error; }
        await fs.rmdir(directory);
      };
    }
    try {
      const entries = await fs.readdir(directory);
      if (entries.length === 1 && /^\d+-[a-f0-9-]+\.owner$/.test(entries[0]!)) {
        const pid = Number(entries[0]!.split("-")[0]);
        let dead = false;
        try { process.kill(pid, 0); } catch (error: any) { dead = error?.code === "ESRCH"; }
        if (dead) {
          // A second contender cannot remove a replacement lock: unlink must succeed first.
          await fs.unlink(path.join(directory, entries[0]!));
          await fs.rmdir(directory);
          continue;
        }
      }
    } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
    if (Date.now() >= deadline) throw new Error("Timed out waiting for local session storage lock");
    await wait(Math.min(100, Math.max(1, deadline - Date.now())), undefined, { signal });
  }
}

export async function acquireAuthLock(profile = DEFAULT_PROFILE, signal?: AbortSignal): Promise<() => Promise<void>> {
  return acquireStorageLock(profile, "authentication", signal, AUTH_TIMEOUT_MS);
}
