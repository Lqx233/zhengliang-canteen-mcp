import crypto from "node:crypto";
import { Entry } from "@napi-rs/keyring";
import { DEFAULT_PROFILE, KEYRING_SERVICE } from "../constants.js";

export interface SecretStore {
  getToken(profile?: string): Promise<string | null>;
  setToken(token: string, profile?: string): Promise<void>;
  deleteToken(profile?: string): Promise<void>;
  getConfigKey(profile?: string): Promise<Buffer | null>;
  ensureConfigKey(profile?: string): Promise<Buffer>;
}

function entry(account: string): Entry {
  return new Entry(KEYRING_SERVICE, account);
}

export class KeyringSecretStore implements SecretStore {
  async getToken(profile = DEFAULT_PROFILE): Promise<string | null> {
    return entry(`${profile}:token`).getPassword() ?? null;
  }

  async setToken(token: string, profile = DEFAULT_PROFILE): Promise<void> {
    if (!token || token.length < 20) throw new Error("Refusing to store an invalid session token");
    entry(`${profile}:token`).setPassword(token);
  }

  async deleteToken(profile = DEFAULT_PROFILE): Promise<void> {
    try {
      entry(`${profile}:token`).deletePassword();
    } catch {
      // Deleting an absent credential is idempotent.
    }
  }

  async getConfigKey(profile = DEFAULT_PROFILE): Promise<Buffer | null> {
    const encoded = entry(`${profile}:config-key`).getPassword();
    if (!encoded) return null;
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32) throw new Error("Stored configuration key has an invalid length");
    return key;
  }

  async ensureConfigKey(profile = DEFAULT_PROFILE): Promise<Buffer> {
    const existing = await this.getConfigKey(profile);
    if (existing) return existing;
    const key = crypto.randomBytes(32);
    entry(`${profile}:config-key`).setPassword(key.toString("base64"));
    return key;
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
