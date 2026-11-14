import { describe, expect, test } from "bun:test";

import {
  activeAgentConfig,
  agentProfileRevisions,
  agentProfiles,
  agentProfileSecrets,
  runnerContexts,
} from "../../src/data/schema";

describe("agent profile persistence schema", () => {
  test("defines profiles, immutable revisions, encrypted secrets and active pointer", () => {
    expect(agentProfiles.id.name).toBe("id");
    expect(agentProfileRevisions.profile_id.name).toBe("profile_id");
    expect(agentProfileRevisions.resume_on_model_change.name).toBe(
      "resume_on_model_change",
    );
    expect(agentProfileSecrets.ciphertext.name).toBe("ciphertext");
    expect(agentProfileSecrets.credential_identity.name).toBe(
      "credential_identity",
    );
    expect(activeAgentConfig.revision_id.name).toBe("revision_id");
  });

  test("stores compatibility fingerprints on runner contexts", () => {
    expect(runnerContexts.provider_fingerprint.name).toBe(
      "provider_fingerprint",
    );
    expect(runnerContexts.model_fingerprint.name).toBe("model_fingerprint");
  });
});
