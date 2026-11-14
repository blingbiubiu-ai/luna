import { createHash, randomBytes } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { ExecutionError, type SqlDatabase } from "@luna/execution-store";

export interface PeerIdentity { role: "service" | "runtime" | "worker" | "executor"; id: string; }
interface CredentialRow { credential_id: string; token_hash: string; role: PeerIdentity["role"]; peer_id: string; revoked: number; }
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const idPattern = /^[A-Za-z0-9_.-]{1,128}$/;

/** Receiver-owned registry: Bearer tokens identify callers, never request-supplied roles. */
export class TokenAuthority {
  private readonly memory = new Map<string, CredentialRow>();
  constructor(private readonly db?: SqlDatabase) {
    db?.exec(`CREATE TABLE IF NOT EXISTS execution_credentials (
      credential_id TEXT PRIMARY KEY, token_hash TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL, peer_id TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0
    )`);
  }

  /** The caller must save the returned secret privately; the registry stores only its hash. */
  issue(credentialId: string, peer: PeerIdentity): string {
    const token = randomBytes(32).toString("base64url");
    this.register(credentialId, token, peer);
    return token;
  }

  /** Retrying a pairing cannot replace a different identity or resurrect a revoked grant. */
  register(credentialId: string, token: string, peer: PeerIdentity): void {
    if (!idPattern.test(credentialId) || !idPattern.test(peer.id) || !["service", "runtime", "worker", "executor"].includes(peer.role) || !tokenPattern.test(token)) {
      throw new ExecutionError(422, "invalid_credential_registration");
    }
    const hash = tokenHash(token);
    if (!this.db) {
      const prior = this.memory.get(credentialId);
      if (prior && (prior.token_hash !== hash || prior.role !== peer.role || prior.peer_id !== peer.id || prior.revoked)) throw new ExecutionError(409, "credential_conflict");
      this.memory.set(credentialId, { credential_id: credentialId, token_hash: hash, role: peer.role, peer_id: peer.id, revoked: 0 });
      return;
    }
    this.db.prepare("INSERT OR IGNORE INTO execution_credentials (credential_id,token_hash,role,peer_id) VALUES (?,?,?,?)").run(credentialId, hash, peer.role, peer.id);
    const row = this.db.prepare("SELECT * FROM execution_credentials WHERE credential_id=?").get(credentialId) as CredentialRow | undefined;
    if (!row || row.token_hash !== hash || row.role !== peer.role || row.peer_id !== peer.id || row.revoked) throw new ExecutionError(409, "credential_conflict");
  }

  revoke(credentialId: string): void {
    if (!this.db) { const row = this.memory.get(credentialId); if (row) row.revoked = 1; return; }
    this.db.prepare("UPDATE execution_credentials SET revoked=1 WHERE credential_id=?").run(credentialId);
  }

  /** Run per request, and again before sending each SSE event or heartbeat. */
  authenticate(request: Pick<IncomingMessage, "rawHeaders" | "headers">): PeerIdentity {
    let count = 0;
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      if (request.rawHeaders[index]?.toLowerCase() === "authorization") count++;
    }
    const value = request.headers.authorization;
    const token = typeof value === "string" && value.startsWith("Bearer ") ? value.slice(7) : "";
    if (count !== 1 || !tokenPattern.test(token)) throw new ExecutionError(401, "invalid_credentials");
    const hash = tokenHash(token);
    const row = this.db ? this.db.prepare("SELECT role,peer_id FROM execution_credentials WHERE token_hash=? AND revoked=0").get(hash) as Pick<CredentialRow, "role" | "peer_id"> | undefined
      : [...this.memory.values()].find(row => row.token_hash === hash && !row.revoked);
    if (!row) throw new ExecutionError(401, "invalid_credentials");
    return { role: row.role, id: row.peer_id };
  }
}

export function requirePeer(peer: PeerIdentity, role: PeerIdentity["role"], id?: string): void {
  if (peer.role !== role || (id !== undefined && peer.id !== id)) throw new ExecutionError(403, "peer_role_denied");
}

function tokenHash(token: string): string { return createHash("sha256").update(token).digest("hex"); }
