import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ExecutionError, transaction, type SqlDatabase } from "@luna/execution-store";
import { ModelAccountSummary, type ModelProviderReference } from "@luna/runner-protocol";
import type { WorkerModel } from "@luna/plugin-contracts";

interface Row { summary: string; ciphertext: string; nonce: string; tag: string }

export class ModelAccountStore {
  private readonly key: Buffer;
  constructor(readonly db: SqlDatabase, dataRoot: string, private workerId: string) {
    const root = join(dataRoot, "model-provider-secrets");
    mkdirSync(root, { recursive: true, mode: 0o700 });
    const path = join(root, "master.key");
    if (!existsSync(path)) writeFileSync(path, randomBytes(32), { flag: "wx", mode: 0o600 });
    if ((statSync(path).mode & 0o077) !== 0) throw new ExecutionError(409, "model_secret_permissions_invalid");
    this.key = readFileSync(path);
    if (this.key.length !== 32) throw new ExecutionError(409, "model_secret_key_invalid");
    db.exec(`CREATE TABLE IF NOT EXISTS worker_model_accounts(revision TEXT PRIMARY KEY,summary TEXT NOT NULL,ciphertext TEXT NOT NULL,nonce TEXT NOT NULL,tag TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS worker_model_current(agent_id TEXT NOT NULL,plugin_id TEXT NOT NULL,provider_id TEXT NOT NULL,revision TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(agent_id,plugin_id,provider_id));
      CREATE TABLE IF NOT EXISTS worker_model_imports(request_id TEXT PRIMARY KEY,hash TEXT NOT NULL,revision TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS worker_model_grants(hash TEXT PRIMARY KEY,record TEXT NOT NULL);`);
  }
  token(identity: unknown): string { return createHmac("sha256", this.key).update(JSON.stringify(identity)).digest("base64url"); }
  current(agentId: string, pluginId: string, providerId: string): ModelAccountSummary | null {
    const row = this.db.prepare("SELECT a.summary FROM worker_model_current c JOIN worker_model_accounts a ON a.revision=c.revision WHERE c.agent_id=? AND c.plugin_id=? AND c.provider_id=?")
      .get(agentId, pluginId, providerId) as { summary: string } | undefined;
    return row ? this.summary(ModelAccountSummary.parse(JSON.parse(row.summary)).credentialRevision) : null;
  }
  requireEnabled(agentId: string, pluginId: string, providerId: string): void {
    const row = this.db.prepare("SELECT enabled FROM worker_model_current WHERE agent_id=? AND plugin_id=? AND provider_id=?")
      .get(agentId, pluginId, providerId) as { enabled: number } | undefined;
    if (!row?.enabled) throw new ExecutionError(403, "model_provider_disabled");
  }
  setEnabled(agentId: string, pluginId: string, enabled: boolean): void {
    this.db.prepare("UPDATE worker_model_current SET enabled=? WHERE agent_id=? AND plugin_id=?").run(Number(enabled), agentId, pluginId);
  }
  imported(requestId: string, identity: unknown): ModelAccountSummary | null {
    const row = this.db.prepare("SELECT hash,revision FROM worker_model_imports WHERE request_id=?").get(requestId) as { hash: string; revision: string } | undefined;
    if (!row) return null;
    if (row.hash !== this.token(identity)) throw new ExecutionError(409, "model_import_conflict");
    return this.summary(row.revision);
  }
  put(input: { agentId: string; pluginId: string; providerId: string; releaseSha256: string; requestId: string;
    expectedRevision: string | null; identity: unknown; credential: unknown; name: string; expiresAt: number | null; models: readonly WorkerModel[] }): ModelAccountSummary {
    return transaction(this.db, () => {
      const existing = this.imported(input.requestId, input.identity);
      if (existing) return existing;
      const prior = this.current(input.agentId, input.pluginId, input.providerId);
      if ((prior?.credentialRevision ?? null) !== input.expectedRevision) throw new ExecutionError(409, "model_account_conflict");
      const revision = randomUUID();
      const summary = ModelAccountSummary.parse({ agentId: input.agentId, pluginId: input.pluginId,
        providerId: input.providerId, releaseSha256: input.releaseSha256, name: input.name,
        expiresAt: input.expiresAt, accountId: prior?.accountId ?? randomUUID(),
        credentialRevision: revision, state: "ready", models: input.models });
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
      cipher.setAAD(this.aad(summary));
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(input.credential), "utf8"), cipher.final()]);
      this.db.prepare("INSERT INTO worker_model_accounts VALUES (?,?,?,?,?)").run(revision, JSON.stringify(summary), encrypted.toString("base64"), nonce.toString("base64"), cipher.getAuthTag().toString("base64"));
      this.db.prepare("INSERT INTO worker_model_current VALUES (?,?,?,?,1) ON CONFLICT(agent_id,plugin_id,provider_id) DO UPDATE SET revision=excluded.revision,enabled=1")
        .run(input.agentId, input.pluginId, input.providerId, revision);
      this.db.prepare("INSERT INTO worker_model_imports VALUES (?,?,?)").run(input.requestId, this.token(input.identity), revision);
      return summary;
    });
  }
  summary(revision: string): ModelAccountSummary {
    const row = this.db.prepare("SELECT summary FROM worker_model_accounts WHERE revision=?").get(revision) as { summary: string } | undefined;
    if (!row) throw new ExecutionError(404, "model_account_revision_missing");
    const summary = ModelAccountSummary.parse(JSON.parse(row.summary));
    return summary.expiresAt !== null && summary.expiresAt <= Date.now() ? { ...summary, state: "expired" } : summary;
  }
  updateModels(revision: string, models: readonly WorkerModel[]): void {
    const summary = this.summary(revision);
    this.db.prepare("UPDATE worker_model_accounts SET summary=? WHERE revision=?")
      .run(JSON.stringify({ ...summary, models }), revision);
  }
  unavailable(revision:string):void{
    const summary=this.summary(revision);
    this.db.prepare("UPDATE worker_model_accounts SET summary=? WHERE revision=?").run(JSON.stringify({...summary,state:"unavailable"}),revision);
  }
  credential(agentId: string, reference: ModelProviderReference): unknown {
    const summary = this.summary(reference.credentialRevision);
    this.requireEnabled(agentId, reference.pluginId, reference.providerId);
    if (reference.workerId !== this.workerId || summary.agentId !== agentId || summary.pluginId !== reference.pluginId
      || summary.providerId !== reference.providerId || summary.accountId !== reference.accountId || summary.releaseSha256 !== reference.releaseSha256) {
      throw new ExecutionError(403, "model_account_scope_mismatch");
    }
    if (summary.state !== "ready") throw new ExecutionError(401, summary.state==="expired"?"model_account_expired":"model_account_unavailable");
    const row = this.db.prepare("SELECT * FROM worker_model_accounts WHERE revision=?").get(reference.credentialRevision) as Row;
    const cipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(row.nonce, "base64"));
    cipher.setAAD(this.aad(summary)); cipher.setAuthTag(Buffer.from(row.tag, "base64"));
    try{return JSON.parse(Buffer.concat([cipher.update(Buffer.from(row.ciphertext, "base64")), cipher.final()]).toString());}
    catch{this.unavailable(reference.credentialRevision);throw new ExecutionError(401,"model_credential_corrupted");}
  }
  private aad(summary: ModelAccountSummary): Buffer {
    return Buffer.from(JSON.stringify([this.workerId, summary.agentId, summary.pluginId, summary.providerId, summary.accountId, summary.credentialRevision]));
  }
}
