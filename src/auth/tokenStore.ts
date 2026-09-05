import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { Entry } from "@napi-rs/keyring";
import { BASE_URL, DEFAULT_PROFILE, KEYRING_SERVICE } from "../constants.js";
import { acquireStorageLock } from "./lock.js";
import { encryptedTokenPath } from "../paths.js";

export interface SecretStore {
  getToken(profile?: string): Promise<string | null>;
  setToken(token: string, profile?: string): Promise<void>;
  deleteToken(profile?: string): Promise<void>;
  getConfigKey(profile?: string): Promise<Buffer | null>;
  ensureConfigKey(profile?: string): Promise<Buffer>;
}

type SecretEntry = Pick<Entry, "getPassword" | "setPassword" | "deletePassword">;

function entry(account: string): SecretEntry {
  return new Entry(KEYRING_SERVICE, account);
}

export class TokenStorageError extends Error {
  constructor(operation: "read" | "save" | "delete" | "key") {
    super(`Secure session storage failed (${operation}). Check the OS credential store and local storage, then retry login with force:true.`);
    this.name = "TokenStorageError";
  }
}

interface TokenEnvelope {
  version: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
}

// keyring-rs reports a UTF-16 byte limit, despite the error text saying chars.
const WINDOWS_CREDENTIAL_LIMIT_BYTES = 2560;

function isCapacityError(error: unknown): boolean {
  return error instanceof Error && /^Value of 'password(?: encoded as UTF-16)?' is longer than the platform limit of \d+ chars$/.test(error.message);
}

function tokenAAD(profile: string): Buffer {
  // Domain separation from ProfileVault even though the OS-backed key is shared.
  return Buffer.from(JSON.stringify([KEYRING_SERVICE, BASE_URL, profile, "session-token", 1]), "utf8");
}

async function readFileToken(profile: string, getKey: () => Promise<Buffer | null>): Promise<string | null> {
  let raw: string;
  try {
    raw = await fs.readFile(encryptedTokenPath(profile), "utf8");
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const key = await getKey();
  // A file without its key is a storage failure, not an absent session.
  if (!key) throw new TokenStorageError("read");
  const envelope = JSON.parse(raw) as TokenEnvelope;
  if (envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm") throw new TokenStorageError("read");
  const iv = Buffer.from(envelope.iv, "base64");
  const tag = Buffer.from(envelope.tag, "base64");
  if (iv.length !== 12 || tag.length !== 16) throw new TokenStorageError("read");
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAAD(tokenAAD(profile));
  decipher.setAuthTag(tag);
  const token = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
  if (token.length < 20) throw new TokenStorageError("read");
  return token;
}

async function writeFileToken(profile: string, token: string, key: Buffer): Promise<void> {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(tokenAAD(profile));
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const envelope: TokenEnvelope = {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  const target = encryptedTokenPath(profile);
  await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, `${JSON.stringify(envelope)}\n`, { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, target);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

async function deleteFileToken(profile: string): Promise<void> {
  try {
    await fs.unlink(encryptedTokenPath(profile));
  } catch (error: any) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function releaseStorageLock(release: (() => Promise<void>) | undefined, operation: "read" | "save" | "delete" | "key"): Promise<void> {
  try { await release?.(); } catch { throw new TokenStorageError(operation); }
}

export class KeyringSecretStore implements SecretStore {
  constructor(
    private readonly makeEntry: (account: string) => SecretEntry = entry,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  async getToken(profile = DEFAULT_PROFILE): Promise<string | null> {
    let release: (() => Promise<void>) | undefined;
    try {
      release = await acquireStorageLock(profile, "token");
      // File wins during a short -> long migration if old-credential cleanup fails.
      const fileToken = await readFileToken(profile, () => this.getConfigKey(profile));
      return fileToken ?? this.makeEntry(`${profile}:token`).getPassword() ?? null;
    } catch {
      throw new TokenStorageError("read");
    } finally { await releaseStorageLock(release, "read"); }
  }

  async setToken(token: string, profile = DEFAULT_PROFILE): Promise<void> {
    if (!token || token.length < 20) throw new Error("Refusing to store an invalid session token");
    let release: (() => Promise<void>) | undefined;
    try {
      release = await acquireStorageLock(profile, "token");
      let useFile = this.platform === "win32" && Buffer.byteLength(token, "utf16le") > WINDOWS_CREDENTIAL_LIMIT_BYTES;
      if (!useFile) {
        try {
          this.makeEntry(`${profile}:token`).setPassword(token);
        } catch (error) {
          if (!isCapacityError(error)) throw error;
          useFile = true;
        }
      }
      if (useFile) {
        await writeFileToken(profile, token, await this.ensureConfigKey(profile));
        // The native API returns false for an absent entry; other failures matter.
        this.makeEntry(`${profile}:token`).deletePassword();
      } else {
        // Report success only after the old file no longer shadows the new value.
        await deleteFileToken(profile);
      }
    } catch {
      // Do not attach native errors as causes: they can include secret values.
      throw new TokenStorageError("save");
    } finally { await releaseStorageLock(release, "save"); }
  }

  async deleteToken(profile = DEFAULT_PROFILE): Promise<void> {
    let release: (() => Promise<void>) | undefined;
    try {
      release = await acquireStorageLock(profile, "token");
      let failed = false;
      try { this.makeEntry(`${profile}:token`).deletePassword(); } catch { failed = true; }
      try { await deleteFileToken(profile); } catch { failed = true; }
      if (failed) throw new TokenStorageError("delete");
    } catch { throw new TokenStorageError("delete"); }
    finally { await releaseStorageLock(release, "delete"); }
  }

  async getConfigKey(profile = DEFAULT_PROFILE): Promise<Buffer | null> {
    try {
      const encoded = this.makeEntry(`${profile}:config-key`).getPassword();
      if (!encoded) return null;
      const key = Buffer.from(encoded, "base64");
      if (key.length !== 32) throw new Error();
      return key;
    } catch {
      throw new TokenStorageError("key");
    }
  }

  async ensureConfigKey(profile = DEFAULT_PROFILE): Promise<Buffer> {
    let release: (() => Promise<void>) | undefined;
    try {
      release = await acquireStorageLock(profile, "config-key");
      const existing = await this.getConfigKey(profile);
      if (existing) return existing;
      const key = crypto.randomBytes(32);
      this.makeEntry(`${profile}:config-key`).setPassword(key.toString("base64"));
      return key;
    } catch {
      throw new TokenStorageError("key");
    } finally { await releaseStorageLock(release, "key"); }
  }
}

export class MemorySecretStore implements SecretStore {
  private tokens = new Map<string, string>();
  private keys = new Map<string, Buffer>();

  async getToken(profile = DEFAULT_PROFILE): Promise<string | null> {
    return this.tokens.get(profile) ?? null;
  }

  async setToken(token: string, profile = DEFAULT_PROFILE): Promise<void> {
    this.tokens.set(profile, token);
  }

  async deleteToken(profile = DEFAULT_PROFILE): Promise<void> {
    this.tokens.delete(profile);
  }

  async getConfigKey(profile = DEFAULT_PROFILE): Promise<Buffer | null> {
    return this.keys.get(profile) ?? null;
  }

  async ensureConfigKey(profile = DEFAULT_PROFILE): Promise<Buffer> {
    const existing = this.keys.get(profile);
    if (existing) return existing;
    const key = crypto.randomBytes(32);
    this.keys.set(profile, key);
    return key;
  }
}
