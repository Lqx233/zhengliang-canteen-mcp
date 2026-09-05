import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { APP_NAME } from "./constants.js";

export function appDataDir(): string {
  if (process.env.ZHENGLIANG_MCP_HOME) return path.resolve(process.env.ZHENGLIANG_MCP_HOME);
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", APP_NAME);
  }
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"), APP_NAME);
  }
  return path.join(os.homedir(), ".config", APP_NAME);
}

export function browserCacheDir(): string {
  if (process.env.ZHENGLIANG_MCP_BROWSER_PATH) {
    return path.resolve(process.env.ZHENGLIANG_MCP_BROWSER_PATH);
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Caches", APP_NAME, "playwright");
  }
  if (process.platform === "win32") {
    return path.join(process.env.LOCALAPPDATA ?? appDataDir(), APP_NAME, "playwright");
  }
  return path.join(os.homedir(), ".cache", APP_NAME, "playwright");
}

export function encryptedProfilePath(profile = "default"): string {
  return path.join(appDataDir(), "profiles", `${profile}.enc.json`);
}

export function encryptedTokenPath(profile = "default"): string {
  const id = crypto.createHash("sha256").update(profile).digest("hex");
  return path.join(appDataDir(), "sessions", `${id}.enc.json`);
}

export function authLockPath(profile = "default"): string {
  return path.join(appDataDir(), "locks", `${profile}.auth.lock`);
}
