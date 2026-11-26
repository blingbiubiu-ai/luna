import {runnerInvocations} from "@/data/schema";
import { ModelProviderReference } from "@luna/runner-protocol";
import {AgentError, AgentStore} from "@/agents/agent-store";
import { createHash } from "node:crypto";
import { and, desc, eq, isNull, ne } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import {
  activeAgentConfig,
  agentProfileRevisions,
  agentProfiles,
  agentProfileSecrets,
  agentShadows,
  shadowModelSelections,
} from "@/data/schema";
import { uuid } from "@/shared";
import { validateAgentProfileInput } from "./profile-validation";
import { isAgentType } from "./type-registry";
import { isExecutionDriver, type AgentProfileInput, type AgentType, type ExecutionDriver, type SecretUpdate } from "./types";
import type { AgentSecretCipher, EncryptedSecret } from "./secret-cipher";

type ProfileRow = typeof agentProfiles.$inferSelect;
type RevisionRow = typeof agentProfileRevisions.$inferSelect;
type SecretRow = typeof agentProfileSecrets.$inferSelect;
type TransactionExecutor = Parameters<Parameters<DrizzleDB["transaction"]>[0]>[0];
type DatabaseExecutor = DrizzleDB | TransactionExecutor;

export interface SecretSummary {
  readonly configured: true;
  readonly updatedAt: number;
}

export interface AgentProfileRevisionView {
  readonly modelProvider?: ModelProviderReference;
  readonly id: string;
  readonly revisionNumber: number;
  readonly model: string;
  readonly executionDriver: ExecutionDriver;
  readonly resumeOnModelChange: boolean;
  readonly env: Record<string, string>;
  readonly secrets: Record<string, SecretSummary>;
  readonly configFingerprint: string;
  readonly validationState: string;
  readonly validationResult: unknown;
  readonly validatedAt: number | null;
  readonly createdAt: number;
}

export interface AgentProfileView {
  readonly id: string;
  readonly agentId: string;
  readonly name: string;
  readonly agentType: AgentType;
  readonly deletedAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly latestRevision: AgentProfileRevisionView;
}

interface CreateProfileInput extends AgentProfileInput {
  readonly name: string;
  readonly actorId?: string;
}

interface CreateRevisionInput extends Omit<AgentProfileInput, "agentType"> {
  readonly actorId?: string;
}

export class AgentProfileStore {
  constructor(
    private readonly db: DrizzleDB,
    private readonly cipher: AgentSecretCipher | undefined,
    readonly agentId: string,
  ) { new AgentStore(db).get(agentId); }

  status(): { status: "setup_required"; active: null } | { status: "ready"; active: AgentProfileView; revision: AgentProfileRevisionView } {
    const active = this.db.select().from(activeAgentConfig).where(eq(activeAgentConfig.agent_id, this.agentId)).get();
    if (active === undefined || !isAgentType(active.agent_type)) {
      return { status: "setup_required", active: null };
    }
    const profile = this.getProfile(active.profile_id);
    if (profile === undefined) return { status: "setup_required", active: null };
    const revision = this.getRevision(active.revision_id);
    if (!revision) return {status: "setup_required", active:null};
    return { status: "ready", active: profile, revision };
  }

  listProfiles(): AgentProfileView[] {
    return this.db.select().from(agentProfiles)
      .where(and(eq(agentProfiles.agent_id, this.agentId), isNull(agentProfiles.deleted_at))).all()
      .map((profile) => this.profileView(profile));
  }

  getProfile(profileId: string): AgentProfileView | undefined {
    const row = this.db.select().from(agentProfiles)
      .where(and(eq(agentProfiles.id, profileId), eq(agentProfiles.agent_id, this.agentId))).get();
    return row === undefined ? undefined : this.profileView(row);
  }

  createProfile(input: CreateProfileInput): AgentProfileView {
    const validated = validateAgentProfileInput(input);
    const name = input.name.trim();
    if (name.length === 0) throw new Error("Agent profile name is required");
    const profileId = uuid();
    const now = Date.now();
    const profile = {
      id: profileId,
      agent_id: this.agentId,
      name,
      agent_type: validated.agentType,
      deleted_at: null,
      created_by_account_id: input.actorId ?? null,
      created_at: now,
      updated_at: now,
    } satisfies ProfileRow;
    this.db.transaction((tx) => {
      tx.insert(agentProfiles).values(profile).run();
      this.insertRevision(tx, profile, validated, input.actorId, 1);
    });
    return this.getProfile(profileId)!;
  }

  createRevision(profileId: string, input: CreateRevisionInput): AgentProfileRevisionView {
    const profile = this.db.select().from(agentProfiles)
      .where(and(eq(agentProfiles.id, profileId), eq(agentProfiles.agent_id, this.agentId), isNull(agentProfiles.deleted_at))).get();
    if (profile === undefined) throw new Error(`Agent profile not found: ${profileId}`);
    const latest = this.latestRevisionRow(profileId);
    if (latest === undefined) throw new Error(`Agent profile has no revision: ${profileId}`);
    const source = input.modelProvider === undefined && latest.model_provider_json ? ModelProviderReference.parse(JSON.parse(latest.model_provider_json)) : input.modelProvider;
    const validated = validateAgentProfileInput({ ...input, ...(source === undefined ? {} : { modelProvider: source }), agentType: profile.agent_type });
    const revision = this.db.transaction((tx) => {
      const created = this.insertRevision(
        tx,
        profile,
        validated,
        input.actorId,
        latest.revision_number + 1,
        latest,
      );
      tx.update(agentProfiles).set({ updated_at: Date.now() })
        .where(eq(agentProfiles.id, profileId)).run();
      return created;
    });
    return this.revisionView(revision);
  }

  getRevision(revisionId: string): AgentProfileRevisionView | undefined {
    const revision = this.db.select().from(agentProfileRevisions).where(eq(agentProfileRevisions.id, revisionId)).get();
    if (!revision || !this.getProfile(revision.profile_id)) return undefined;
    return this.revisionView(revision);
  }

  recordValidation(
    revisionId: string,
    result: { readonly success: boolean; readonly message: string },
  ): AgentProfileRevisionView {
    const existing = this.db.select().from(agentProfileRevisions)
      .where(eq(agentProfileRevisions.id, revisionId)).get();
    if (existing === undefined || !this.getProfile(existing.profile_id)) throw new Error(`Agent profile revision not found: ${revisionId}`);
    this.db.update(agentProfileRevisions).set({
      validation_state: result.success ? "validated" : "invalid",
      validation_result_json: JSON.stringify({ message: result.message }),
      validated_at: Date.now(),
    }).where(eq(agentProfileRevisions.id, revisionId)).run();
    const updated = this.db.select().from(agentProfileRevisions)
      .where(eq(agentProfileRevisions.id, revisionId)).get();
    return this.revisionView(updated!);
  }

  deleteProfile(profileId: string, _actorId?: string): void {
    if (!this.getProfile(profileId)) throw new Error(`Agent profile not found: ${profileId}`);
    const active = this.db.select().from(activeAgentConfig)
      .where(eq(activeAgentConfig.profile_id, profileId)).get();
    if (active !== undefined) throw new Error("Cannot delete the active Agent profile");
    const selected=this.db.select({id:shadowModelSelections.shadowId}).from(shadowModelSelections)
      .innerJoin(agentShadows,eq(agentShadows.id,shadowModelSelections.shadowId))
      .where(and(eq(shadowModelSelections.profileId,profileId),ne(agentShadows.status,"deleted"))).get();
    if(selected)throw new AgentError("agent_profile_in_use",409);
    const retained=this.db.select({config:runnerInvocations.agentConfig,settledAt:runnerInvocations.settledAt}).from(runnerInvocations)
      .where(eq(runnerInvocations.agentId,this.agentId)).all();
    if(retained.some(row=>row.settledAt===null && row.config?.profileId===profileId)) throw new Error("Cannot delete an Agent profile used by an unsettled invocation");
    this.db.update(agentProfiles).set({ deleted_at: Date.now(), updated_at: Date.now() })
      .where(eq(agentProfiles.id, profileId)).run();
  }

  private profileView(profile: ProfileRow): AgentProfileView {
    const latest = this.latestRevisionRow(profile.id);
    if (latest === undefined) throw new Error(`Agent profile has no revision: ${profile.id}`);
    return {
      id: profile.id,
      agentId: profile.agent_id,
      name: profile.name,
      agentType: profile.agent_type as AgentType,
      deletedAt: profile.deleted_at,
      createdAt: profile.created_at,
      updatedAt: profile.updated_at,
      latestRevision: this.revisionView(latest),
    };
  }

  private revisionView(revision: RevisionRow): AgentProfileRevisionView {
    const secrets = this.db.select().from(agentProfileSecrets)
      .where(eq(agentProfileSecrets.revision_id, revision.id)).all();
    return {
      ...(revision.model_provider_json ? { modelProvider: ModelProviderReference.parse(JSON.parse(revision.model_provider_json)) } : {}),
      id: revision.id,
      revisionNumber: revision.revision_number,
      model: revision.model,
      executionDriver: isExecutionDriver(revision.execution_driver) ? revision.execution_driver : "stdio",
      resumeOnModelChange: revision.resume_on_model_change,
      env: parseObject(revision.env_json),
      secrets: Object.fromEntries(
        secrets.map((secret) => [secret.env_key, { configured: true as const, updatedAt: secret.updated_at }]),
      ),
      configFingerprint: revision.config_fingerprint,
      validationState: revision.validation_state,
      validationResult: revision.validation_result_json === null
        ? null
        : JSON.parse(revision.validation_result_json),
      validatedAt: revision.validated_at,
      createdAt: revision.created_at,
    };
  }

  private latestRevisionRow(profileId: string): RevisionRow | undefined {
    return this.db.select().from(agentProfileRevisions)
      .where(eq(agentProfileRevisions.profile_id, profileId))
      .orderBy(desc(agentProfileRevisions.revision_number)).get();
  }

  private insertRevision(
    db: DatabaseExecutor,
    profile: ProfileRow,
    input: ReturnType<typeof validateAgentProfileInput>,
    actorId: string | undefined,
    revisionNumber: number,
    previous?: RevisionRow,
  ): RevisionRow {
    const revisionId = uuid();
    const now = Date.now();
    const previousSecrets = previous === undefined
      ? []
      : db.select().from(agentProfileSecrets)
        .where(eq(agentProfileSecrets.revision_id, previous.id)).all();
    const plaintextSecrets = this.resolveSecrets(profile.id, previous, previousSecrets, input.secrets);
    if(input.modelProvider && plaintextSecrets.OPENAI_API_KEY)throw new Error("Worker plugin models cannot retain a gateway API key; clear it explicitly");
    if (
      input.agentType === "codex" && input.env.CODEX_PROVIDER_MODE === "gateway" &&
      !plaintextSecrets.OPENAI_API_KEY?.trim()
    ) {
      throw new Error("Codex gateway requires an OPENAI_API_KEY secret");
    }
    const fingerprint = configFingerprint(
      input.agentType,
      input.model,
      input.executionDriver,
      input.resumeOnModelChange,
      input.env,
      Object.fromEntries(
        Object.entries(plaintextSecrets).map(([key, value]) => [
          key,
          this.secretCipher().credentialIdentity(key, value),
        ]),
      ),
      input.modelProvider,
    );
    const revision = {
      id: revisionId,
      profile_id: profile.id,
      revision_number: revisionNumber,
      model: input.model,
      execution_driver: input.executionDriver,
      resume_on_model_change: input.resumeOnModelChange,
      env_json: JSON.stringify(sortRecord(input.env)),
      model_provider_json: input.modelProvider ? JSON.stringify(input.modelProvider) : null,
      config_fingerprint: fingerprint,
      validation_state: "draft",
      validation_result_json: null,
      validated_at: null,
      created_by_account_id: actorId ?? null,
      created_at: now,
    } satisfies RevisionRow;
    db.insert(agentProfileRevisions).values(revision).run();
    for (const [key, plaintext] of Object.entries(plaintextSecrets)) {
      const encrypted = this.secretCipher().encrypt({ profileId: profile.id, revisionId, key, plaintext });
      db.insert(agentProfileSecrets).values(toSecretRow(revisionId, key, encrypted, actorId, now)).run();
    }
    return revision;
  }

  private resolveSecrets(
    profileId: string,
    previous: RevisionRow | undefined,
    previousSecrets: SecretRow[],
    updates: Record<string, SecretUpdate>,
  ): Record<string, string> {
    const values: Record<string, string> = {};
    if (previous !== undefined) {
      for (const secret of previousSecrets) {
        values[secret.env_key] = this.secretCipher().decrypt({
          profileId,
          revisionId: previous.id,
          key: secret.env_key,
          ciphertext: secret.ciphertext,
          nonce: secret.nonce,
          authTag: secret.auth_tag,
          algorithm: secret.algorithm as "aes-256-gcm",
          keyVersion: secret.key_version,
          credentialIdentity: secret.credential_identity,
        });
      }
    }
    for (const [key, update] of Object.entries(updates)) {
      if ("clear" in update) delete values[key];
      else values[key] = update.set;
    }
    return values;
  }

  private secretCipher(): AgentSecretCipher {
    if (this.cipher === undefined) {
      const error = new Error("Agent configuration secret key is unavailable");
      error.name = "AgentSecretKeyUnavailableError";
      throw error;
    }
    return this.cipher;
  }
}

function toSecretRow(
  revisionId: string,
  key: string,
  encrypted: EncryptedSecret,
  actorId: string | undefined,
  now: number,
): SecretRow {
  return {
    revision_id: revisionId,
    env_key: key,
    ciphertext: encrypted.ciphertext,
    nonce: encrypted.nonce,
    auth_tag: encrypted.authTag,
    algorithm: encrypted.algorithm,
    key_version: encrypted.keyVersion,
    credential_identity: encrypted.credentialIdentity,
    updated_by_account_id: actorId ?? null,
    updated_at: now,
  };
}

function configFingerprint(
  agentType: string,
  model: string,
  executionDriver: ExecutionDriver,
  resume: boolean,
  env: Record<string, string>,
  secretIdentities: Record<string, string>,
  modelProvider?: ModelProviderReference,
): string {
  return createHash("sha256").update(JSON.stringify({
    agentType,
    model,
    ...(executionDriver === "stdio" ? {} : { executionDriver }),
    resume,
    env: sortRecord(env),
    secretIdentities: sortRecord(secretIdentities),
    ...(modelProvider ? { modelProvider } : {}),
  })).digest("hex");
}

function sortRecord(values: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(values).toSorted(([a], [b]) => a.localeCompare(b)));
}

function parseObject(value: string): Record<string, string> {
  const parsed = JSON.parse(value) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return parsed as Record<string, string>;
}
