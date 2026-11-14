import { readFileSync, statSync } from "node:fs";
import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";

const ALGORITHM = "aes-256-gcm";

export interface SecretBinding {
  readonly profileId: string;
  readonly revisionId: string;
  readonly key: string;
}

export interface EncryptedSecret {
  readonly ciphertext: string;
  readonly nonce: string;
  readonly authTag: string;
  readonly algorithm: typeof ALGORITHM;
  readonly keyVersion: number;
  readonly credentialIdentity: string;
}

type MasterKeyEnvironment = Readonly<Record<string, string | undefined>>;

export class AgentSecretCipher {
  private constructor(private readonly masterKey: Buffer) {}

  static tryFromEnvironment(env: MasterKeyEnvironment = process.env): AgentSecretCipher | undefined {
    const encoded = env.LUNA_AGENT_CONFIG_MASTER_KEY?.trim();
    if (encoded !== undefined && encoded.length > 0) {
      return new AgentSecretCipher(parseMasterKey(encoded));
    }
    const keyFile = env.LUNA_AGENT_CONFIG_MASTER_KEY_FILE?.trim();
    if (keyFile === undefined || keyFile.length === 0) return undefined;
    const stat = statSync(keyFile);
    if ((stat.mode & 0o077) !== 0) {
      throw new Error("Agent configuration master key file must be owner-only");
    }
    return new AgentSecretCipher(parseMasterKey(readFileSync(keyFile, "utf8").trim()));
  }

  static fromEnvironment(env: MasterKeyEnvironment = process.env): AgentSecretCipher {
    const cipher = AgentSecretCipher.tryFromEnvironment(env);
    if (cipher === undefined) {
      throw new Error("Agent configuration master key is unavailable");
    }
    return cipher;
  }

  encrypt(input: SecretBinding & { readonly plaintext: string }): EncryptedSecret {
    const nonce = randomBytes(12);
    const cipher = createCipheriv(ALGORITHM, this.masterKey, nonce);
    cipher.setAAD(bindingBytes(input));
    const ciphertext = Buffer.concat([
      cipher.update(input.plaintext, "utf8"),
      cipher.final(),
    ]);
    return {
      ciphertext: ciphertext.toString("base64"),
      nonce: nonce.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      algorithm: ALGORITHM,
      keyVersion: 1,
      credentialIdentity: this.credentialIdentity(input.key, input.plaintext),
    };
  }

  decrypt(input: SecretBinding & EncryptedSecret): string {
    if (input.algorithm !== ALGORITHM || input.keyVersion !== 1) {
      throw new Error("Unsupported encrypted Agent secret format");
    }
    const decipher = createDecipheriv(
      ALGORITHM,
      this.masterKey,
      Buffer.from(input.nonce, "base64"),
    );
    decipher.setAAD(bindingBytes(input));
    decipher.setAuthTag(Buffer.from(input.authTag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(input.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
  }

  credentialIdentity(key: string, value: string): string {
    return createHmac("sha256", this.masterKey)
      .update("luna-agent-credential\0")
      .update(key)
      .update("\0")
      .update(value)
      .digest("hex");
  }
}

function parseMasterKey(encoded: string): Buffer {
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) {
    throw new Error("Agent configuration master key must be 32 base64-encoded bytes");
  }
  return key;
}

function bindingBytes(binding: SecretBinding): Buffer {
  return Buffer.from(
    `${binding.profileId}\0${binding.revisionId}\0${binding.key}`,
    "utf8",
  );
}
