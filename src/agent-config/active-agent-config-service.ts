import {executionReference, executionReferenceSchema, type AgentExecutionReference} from "./execution-reference";
import { ModelProviderReference } from "@luna/runner-protocol";
import {AgentError, AgentStore} from "@/agents/agent-store";
import {ShadowModelSelectionStore} from "@/agents/shadow-model-selection-store";
import {TaskScopeResolver} from "@/agents/task-scope";
import type {AgentScope} from "@/agents/agent-store";
import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";

import type { DrizzleDB } from "@/data";
import {
  activeAgentConfig,
  agentProfileRevisions,
  agentProfiles,
  agentProfileSecrets,
} from "@/data/schema";
import { agentTypeDescriptor, isAgentType } from "./type-registry";
import type { AgentSecretCipher } from "./secret-cipher";
import { isExecutionDriver, type AgentType, type ExecutionDriver } from "./types";

export class AgentNotConfiguredError extends Error {
  readonly code = "agent_not_configured";

  constructor() {
    super("No Agent profile is active. Configure one in Dashboard first.");
    this.name = "AgentNotConfiguredError";
  }
}

export interface AgentExecutionSnapshot {
  readonly modelProvider?: ModelProviderReference;
  readonly agentId: string;
  readonly profileId: string;
  readonly revisionId: string;
  readonly activationSequence: number;
  readonly agentType: AgentType;
  readonly model: string;
  readonly executionDriver: ExecutionDriver;
  readonly resumeOnModelChange: boolean;
  readonly env: Readonly<Record<string, string>>;
  readonly providerFingerprint: string;
  readonly modelFingerprint: string;
  readonly configFingerprint: string;
}

export class ActiveAgentConfigService {
  constructor(
    private readonly db: DrizzleDB,
    private readonly cipher: AgentSecretCipher | undefined,
  ) {}

  activate(agentId: string, revisionId: string, actorId: string): AgentExecutionSnapshot {
    return this.db.transaction(() => {
      new AgentStore(this.db).requireOwner(actorId, agentId);
      const revision = this.db.select().from(agentProfileRevisions)
        .where(eq(agentProfileRevisions.id, revisionId)).get();
      if (revision === undefined) throw new Error(`Agent profile revision not found: ${revisionId}`);
      if (revision.validation_state !== "validated") {
        throw new Error("Agent profile revision must be validated before activation");
      }
      const profile = this.db.select().from(agentProfiles)
        .where(eq(agentProfiles.id, revision.profile_id)).get();
      if (profile === undefined || profile.agent_id !== agentId || profile.deleted_at !== null) {
        throw new Error(`Agent profile not found: ${revision.profile_id}`);
      }
      agentTypeDescriptor(profile.agent_type);
      const current = this.db.select().from(activeAgentConfig)
        .where(eq(activeAgentConfig.agent_id, agentId)).get();
      const values = {
        agent_id: agentId,
        agent_type: profile.agent_type,
        profile_id: profile.id,
        revision_id: revision.id,
        activation_sequence: (current?.activation_sequence ?? 0) + 1,
        activated_by_account_id: actorId,
        activated_at: Date.now(),
      };
      this.db.insert(activeAgentConfig).values(values).onConflictDoUpdate({
        target: activeAgentConfig.agent_id,
        set: values,
      }).run();
      return this.resolveExecutionSnapshot(agentId);
    });
  }

  resolveExecutionSnapshot(agentId: string): AgentExecutionSnapshot {
    this.requireActiveAgent(agentId);
    const active = this.db.select().from(activeAgentConfig)
      .where(eq(activeAgentConfig.agent_id, agentId)).get();
    if (active === undefined) throw new AgentNotConfiguredError();
    return this.resolveRevisionSnapshot(agentId, active.revision_id, active.activation_sequence);
  }

  resolveShadowExecutionSnapshot(scope:AgentScope):AgentExecutionSnapshot {
    new TaskScopeResolver(this.db).active(scope);
    const selection=new ShadowModelSelectionStore(this.db).get(scope);
    if(selection.mode==="inherit")return this.resolveExecutionSnapshot(scope.agentId);
    const revision=this.db.select().from(agentProfileRevisions).where(eq(agentProfileRevisions.id,selection.revisionId)).get();
    if(!revision || revision.validation_state!=="validated")throw new AgentError("shadow_model_not_validated",409);
    const snapshot=this.resolveRevisionSnapshot(scope.agentId,selection.revisionId);
    if(snapshot.profileId!==selection.profileId)throw new AgentError("shadow_model_unavailable",409);
    return snapshot;
  }

  resolveActiveAgentType(agentId: string): AgentType {
    this.requireActiveAgent(agentId);
    const active = this.db.select().from(activeAgentConfig)
      .where(eq(activeAgentConfig.agent_id, agentId)).get();
    if (active === undefined || !isAgentType(active.agent_type)) throw new AgentNotConfiguredError();
    return active.agent_type;
  }

  resolvePinnedSnapshot(agentId:string, reference:AgentExecutionReference):AgentExecutionSnapshot {
    this.requireActiveAgent(agentId);
    const expected=executionReferenceSchema.parse(reference);
    if(expected.agentId!==agentId) throw new AgentError("execution_config_scope_mismatch",409);
    const snapshot=this.resolveRevisionSnapshot(agentId,expected.revisionId,expected.activationSequence);
    if(JSON.stringify(executionReference(snapshot))!==JSON.stringify(expected)) throw new AgentError("execution_config_changed",409);
    return snapshot;
  }

  private requireActiveAgent(agentId: string): void {
    if (new AgentStore(this.db).get(agentId).status !== "active") throw new AgentError("agent_disabled",409);
  }

  resolveRevisionSnapshot(
    agentId: string,
    revisionId: string,
    activationSequence = 0,
  ): AgentExecutionSnapshot {
    if (new AgentStore(this.db).get(agentId).status === "deleted") throw new AgentError("agent_deleted",404);
    const revision = this.db.select().from(agentProfileRevisions)
      .where(eq(agentProfileRevisions.id, revisionId)).get();
    const profile = revision === undefined ? undefined : this.db.select().from(agentProfiles)
      .where(eq(agentProfiles.id, revision.profile_id)).get();
    if (revision === undefined || profile === undefined || profile.agent_id !== agentId || profile.deleted_at !== null ||
      !isAgentType(profile.agent_type)) {
      throw new AgentNotConfiguredError();
    }
    const agentType = profile.agent_type;
    const env = JSON.parse(revision.env_json) as Record<string, string>;
    const secretRows = this.db.select().from(agentProfileSecrets)
      .where(eq(agentProfileSecrets.revision_id, revision.id)).all();
    if (secretRows.length > 0 && this.cipher === undefined) {
      const error = new Error("Agent configuration secret key is unavailable");
      error.name = "AgentSecretKeyUnavailableError";
      throw error;
    }
    for (const secret of secretRows) {
      env[secret.env_key] = this.cipher!.decrypt({
        profileId: profile.id,
        revisionId: revision.id,
        key: secret.env_key,
        ciphertext: secret.ciphertext,
        nonce: secret.nonce,
        authTag: secret.auth_tag,
        algorithm: secret.algorithm as "aes-256-gcm",
        keyVersion: secret.key_version,
        credentialIdentity: secret.credential_identity,
      });
    }

    const descriptor = agentTypeDescriptor(agentType);
    const known = new Map(descriptor.envFields.map((field) => [field.key, field] as const));
    const providerEnv: Record<string, string> = {};
    const modelEnv: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
      const field = known.get(key);
      if (field?.sensitive === true) continue;
      if (field?.affectsProviderIdentity === false) modelEnv[key] = value;
      else providerEnv[key] = value;
    }
    const credentialIdentities = Object.fromEntries(
      secretRows.map((secret) => [secret.env_key, secret.credential_identity]),
    );
    const modelProvider = revision.model_provider_json ? ModelProviderReference.parse(JSON.parse(revision.model_provider_json)) : undefined;
    return Object.freeze({
      ...(modelProvider ? { modelProvider } : {}),
      agentId,
      profileId: profile.id,
      revisionId: revision.id,
      activationSequence,
      agentType,
      model: revision.model,
      executionDriver: isExecutionDriver(revision.execution_driver) ? revision.execution_driver : "stdio",
      resumeOnModelChange: revision.resume_on_model_change,
      env: Object.freeze({ ...env }),
      providerFingerprint: hash({ agentType, providerEnv, credentialIdentities, ...(modelProvider ? { modelProvider } : {}) }),
      modelFingerprint: hash({ model: revision.model, modelEnv }),
      configFingerprint: revision.config_fingerprint,
    });
  }
}

function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
