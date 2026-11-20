# Agent Configuration

## Responsibility Boundary

Agent configuration is Dashboard-managed runtime state. `config.yaml` does not
contain an Agent type or model. A new Luna installation starts normally. Each Agent reports `setup_required` until its owner creates, tests, and activates a Profile. Runtime status reports service/channel health without a global Agent model.

The Model Configuration page lists the signed-in user's owned Agents. The link
from My Agents selects the current Agent. Profile reads, mutations and
connection tests include its `agentId`, and the Service checks ownership.
Switching Agents clears the open editor and uses a separate query cache.

The supported Agent types are `claude` and `codex`. Their
descriptors provide known environment fields and allowed custom prefixes. The
Profile data model remains generic: every revision contains a model, an
execution driver (`stdio` default or `pty` interactive pseudo-terminal), the
model-change resume policy, non-sensitive environment values, and write-only
secret values.

Claude Profiles explicitly support the unprefixed `API_TIMEOUT_MS` field used
by Claude Code. Other custom Claude variables must still use the
`ANTHROPIC_` or `CLAUDE_CODE_` prefixes.

Codex Profiles default to the built-in provider. Selecting Custom gateway
sets `CODEX_PROVIDER_MODE=gateway` and requires an HTTP(S) `OPENAI_BASE_URL`
and a write-only `OPENAI_API_KEY` secret. The Codex runner generates explicit
CLI overrides for a custom Responses provider with WebSockets disabled.
The overrides reference the credential by environment variable name. The
credential value is supplied in the job environment. Connection tests and
new or resumed runs use the same argument builder. Connection mode, endpoint
and credential identity all affect resume compatibility.

On existing installations, create, validate and activate a replacement Codex
Profile before retiring any legacy `codexfixedargs` Profile. Fixed arguments
may contain provider-specific behavior and require review before migration.

## Persistence And Secrets

`agent_profiles` owns stable names and Agent types. Each edit creates an
immutable `agent_profile_revisions` row (including `execution_driver`, defaulting to `stdio`). `active_agent_config` has one pointer per `agent_id` to a validated revision; activation does not rewrite runner contexts
or scan the database.

Secrets are stored separately in `agent_profile_secrets` with AES-256-GCM.
Luna reads the 32-byte base64 master key from
`LUNA_AGENT_CONFIG_MASTER_KEY` or from the owner-only file named by
`LUNA_AGENT_CONFIG_MASTER_KEY_FILE`. Dashboard responses expose only whether a
secret is configured. Each secret also has an HMAC credential identity so Luna
can compare providers without decrypting or persisting plaintext credentials.

The service can start without a Profile or master key. A master key is required
to create or resolve secret-bearing revisions.

## Validation And Activation

An Agent owner manages Profiles through the Agent-scoped configuration API. The existing `/settings/agents` client still needs Agent selection. A revision must pass
the connection test before activation. The test launches a one-shot
`luna-runner:latest` container with a 60-second timeout and runs
`job-main.js` (mounting the local Executor runtime bundle read-only when testing `executionDriver: "pty"`) with the selected Agent type, execution driver, model, and revision
environment over stdin. It has no business workspace, runner session,
or Luna Service credential mounts. Test output is bounded and configured values
are redacted before persistence or response.

Activation updates only the selected Agent's pointer and activation sequence in one transaction. Composite foreign keys reject a profile owned by another Agent or a revision owned by another profile. Secret-resolution failure rolls back activation. Status returns the actual active revision even when a newer draft exists.

Shadow settings default to following that activation pointer. An owner can instead
select a validated profile revision in `shadow_model_selections`, including a
profile that is not globally active. Fixed selections use the full selected
configuration (provider, model, credentials and resume policy) and stay on that
revision until saved again. `resolveShadowExecutionSnapshot` applies this choice
only when a new invocation starts; an existing invocation still resolves its
pinned execution reference. Selection responses contain display metadata and
IDs, never decrypted credentials. A profile selected by a non-deleted Shadow
cannot be deleted until the selection is released. The Dashboard marks draft or
failed-validation choices unavailable and shows the active model beside the
default option.

Kernel requires an explicit Agent/Shadow scope and validates active state. Main and Work resolve from the actual session; Task resolves from the actual task. Task result notifications and session triggers resolve runner type from their destination session. Cached runner identity includes Agent, revision and configuration fingerprint. There is no global current/default-Agent fallback. New executions resolve the Shadow's fixed revision, or the Agent's active revision when the Shadow inherits. Invocation registration persists `agent_config_json` containing Agent/Profile/Revision IDs, activation sequence, runner type/model and configuration fingerprints, without environment or secrets. Recovery resolves that exact revision and verifies fingerprints; missing or changed references fail closed. Main and Work restore the invocation before model selection; Task resolves its original model type before preparing its context. Transport validates the pinned type/model before preparing or submitting a Job. Database triggers reject a cross-Agent/revision reference or later replacement of the reference.

An unconfigured/mock invocation can have no model reference, but Claude/Codex transport rejects it. Production service environment creation records the selected snapshot reference alongside invocation registration. A profile used by an unsettled invocation cannot be deleted even after another profile activates. Credentials are decrypted again from the pinned revision on recovery; model activation cannot swap the credentials of an existing invocation. Scope/lifecycle admission checks still run before reuse. Full end-to-end recovery with the new Worker topology and the converted real database remains pending.

## Resume Compatibility

Runner contexts persist separate provider and model fingerprints. Immediately
before execution Luna compares the context with the selected revision:

- Agent type changes select a different runner context and cannot reuse the old
  provider resume id.
- Base URL, credential identity, or another provider-identity field change
  clears the resume id.
- A model-only change preserves or clears the resume id according to the
  revision's `resumeOnModelChange` value, which defaults to enabled for all
  supported Agent types.

This check is lazy. Activation never performs a database-wide refresh.

## Primary Code Paths

- `src/agent-config/`
- `src/data/schema/agent-profiles.ts`
- `src/server/routes/agent-config.ts`
- `apps/dashboard/src/app/settings/agents.tsx`
- `apps/dashboard/src/app/settings/agent-config-dashboard.tsx`
- `src/runners/runner-context-store.ts`
- `src/kernel/kernel.ts`

## Dashboard Configuration Management

The Agents page groups profiles by agent type in a side navigation
and shows searchable profiles in a table. Each row exposes Edit, connection test,
activation, and deletion; connection details are expandable. New and Edit open
a right-side drawer. Editing pre-fills the latest revision and saves a new
revision, preserving omitted write-only secrets. Validation remains required
before activation. Active status is revision-specific, so a newer validated
revision of the active profile can be activated; deleting the active profile
remains disabled. The header summarizes the configuration currently in use.

Connection tests show an in-progress message and disable duplicate submissions.
The row displays success or the server's redacted failure diagnostic separately
from its Active badge. Both successful and failed requests refresh configuration
queries, since failed tests persist validation state too. Saved validation results
remain visible after reload; transport errors are displayed for the current test.

The profile editor lists configured secret key names with masked status. Replace
opens a blank password input; cancelling replacement preserves the stored value.
Add secret creates separate key/value fields. Only explicit additions and
replacements are submitted; duplicate names and blank replacement values are
rejected. Existing plaintext values are never fetched by the dashboard.


## Agent-owned Profile storage and management API

`agent_profiles.agent_id` is mandatory and immutable. Profile names are unique within `(agent_id, agent_type, name)`. AgentProfileStore requires an explicit Agent at construction and filters list/get/revision mutation/validation/deletion by that ownership. Revisions and encrypted secrets retain their profile binding; the store cannot validate or delete another Agent's revision/profile by ID. Public Profile views include agentId and expose only configured-secret metadata.

The existing `/api/agent-config` routes now require an explicit `agentId` query parameter and an authenticated Dashboard user who owns that Agent. A platform administrator does not receive implicit access to other owners' configurations. Revision test/activation resolves ownership before any secret-bearing snapshot or connection executor is called. After asynchronous connection testing, ownership is checked again before recording validation. Missing scope is rejected, with no default Agent.

All configuration requests require explicit Agent scope. Runtime overview reports service health rather than a global model.

Dashboard memory pages list Agent-scoped memory entries with their origin and
revision history ([Agent memory](agent-memory.md)). A Shadow's persona is edited
there as `persona` entries of that Shadow. Saves use the revision captured when
opening the draft. Stale writes require reloading. Scope changes reset editor state and
Agent-scoped knowledge directory, file, search and Git caches.

Agent settings also manage an optional Git knowledge source. Source configuration
and operation state live outside the knowledge repository; initialization and
manual synchronization run in Service. See [Agent knowledge Git sources](agent-knowledge-sources.md).
