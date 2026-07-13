import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { BASE_URL, DEFAULT_PROFILE } from "../constants.js";
import { encryptedProfilePath } from "../paths.js";
import type { SecretStore } from "../auth/tokenStore.js";
import type { TenantProfile } from "../types.js";

interface Envelope {
  version: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  tag: string;
  ciphertext: string;
}

function aad(profile: string): Buffer {
  return Buffer.from(`${BASE_URL}\n${profile}\nv1`, "utf8");
}

export class ProfileVault {
  constructor(private readonly secrets: SecretStore) {}

  async load(profile = DEFAULT_PROFILE): Promise<TenantProfile | null> {
    const key = await this.secrets.getConfigKey(profile);
    if (!key) return null;
    let raw: string;
    try {
      raw = await fs.readFile(encryptedProfilePath(profile), "utf8");
    } catch (error: any) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    const envelope = JSON.parse(raw) as Envelope;
    if (envelope.version !== 1 || envelope.algorithm !== "aes-256-gcm") {
      throw new Error("Unsupported encrypted profile format");
    }
    const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64"));
    decipher.setAAD(aad(profile));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]);
    return JSON.parse(plaintext.toString("utf8")) as TenantProfile;
  }

  async save(value: TenantProfile, profile = DEFAULT_PROFILE): Promise<void> {
    const key = await this.secrets.ensureConfigKey(profile);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
    cipher.setAAD(aad(profile));
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value), "utf8"),
      cipher.final(),
    ]);
    const envelope: Envelope = {
      version: 1,
      algorithm: "aes-256-gcm",
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
    const target = encryptedProfilePath(profile);
    await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(envelope)}\n`, { mode: 0o600 });
    await fs.rename(temporary, target);
  }
}
