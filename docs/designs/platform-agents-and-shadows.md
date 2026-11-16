# Agents and Shadows

An Agent owns model configuration, shared memory, knowledge and plugin
configuration. A Shadow owns a reply identity, channel bindings, sessions and
execution context. Runtime places execution on Workers authorized for the
Agent. Worker mounts the selected Shadow's persistent HOME and resource snapshot.

## Ownership and persistence

`src/agents/agent-store.ts` manages Agents, Shadows and idempotent creation
receipts through the shared Drizzle connection. The current SQL baseline creates
the platform tables directly.

An active human owns each Agent. Agent creation atomically creates its primary
Shadow, a dedicated `kind=system` reply user and a creation receipt. Additional
Shadows use the same model; reply users are never shared between Shadows.
A deferred composite foreign key binds the Agent's default Shadow to that Agent.
Schema changes must retain `DEFERRABLE INITIALLY DEFERRED` in the SQL baseline.

Creation receipts are scoped by actor and operation. Reusing a key with different
input fails; identical input returns the existing entity.

## Model selection

`ShadowModelSelectionStore` and `shadow_model_selections` store each Shadow's
selection. Without a record, the Shadow follows the Agent's active Profile.
A fixed selection points to a validated revision belonging to that Agent and
uses its provider, credentials, model and resume policy. It does not change the
Agent's activation pointer. Updating a Profile does not silently advance fixed
Shadow selections; owners explicitly select and save another revision. Profiles
referenced by non-deleted Shadows cannot be deleted.

New invocations resolve and freeze their configuration through
`AgentExecutionReference`. In-flight work keeps its original snapshot. Later
invocations use the new selection and existing provider/model compatibility
checks to decide whether a provider session can resume.

## Worker routing

`ShadowWorkerRoutingStore` and `shadow_worker_routing` store automatic or bound
routing. A missing record means automatic selection. A bound Worker must have an
active assignment to the same Agent; routing configuration does not grant access.

A changed rule applies when the next session or task execution is prepared.
Runtime switches only eligible idle contexts and invalidates provider sessions
when the instruction fingerprint changes. Worker-local files are not migrated.
Existing reservations and unknown execution outcomes retain their original
Worker. See [Execution runtime](execution-runtime-foundation.md).

## Authorization and management

`requireOwner` restricts Dashboard access and management to the Agent owner.
`requireAccess` checks active user and Agent state; `requireScope` additionally
checks Shadow ownership and state. Platform administrator status does not bypass
private Agent ownership checks.

`/api/agents` exposes Agent and Shadow creation and queries. Creation requires
Dashboard authentication, a valid name and an idempotency key. Agent owners manage
their business authorization rules; platform rules use the administrator surface.
Lists return only the signed-in owner's Agents. Memory and knowledge are Agent
scoped; a Shadow's persona is a set of Shadow-private memory entries. Updates
use revisions to reject stale writes. Shared memory is entry-level and written
by Shadows as they work; see [Agent memory](agent-memory.md).

## Channel bindings and replies

Enabled, verified bot bindings route external messages to a Shadow. Each Shadow
uses its dedicated system user as the reply author. A changed binding does not
merge reply users or rewrite historical message authors. Normalized identity
observations remain tied to the authenticated provider application scope.

Session access verifies its fixed Agent/Shadow and channel binding. Rebinding
must not cause an existing invocation to send as another bot or read another
Shadow's context. The sender and target are checked again before side effects.
See [Messages and channels](messages-and-channels.md) and
[Identity and users](identity-and-users.md).

## Execution and artifacts

Session, task, invocation, Runner context and artifact ownership are persisted.
Task creation and execution validate their owning Agent/Shadow. Runner credentials
derive scope from the active invocation and Job, rather than caller-provided
identity. Resource preparation and Job acceptance compare the complete scope and
fixed resource selection.

Artifacts must remain within the execution owner scope and pass the normal human
or Runner access checks. A related user does not expand a Runner's artifact
allowlist. Signed URLs are the explicit sharing mechanism.

Lifecycle operations recheck actor status, ownership, grants and bindings before
accepting work and after asynchronous preparation. Revocation, cancellation,
preparation release and physical process shutdown follow the existing execution
ledgers; revocation alone is not proof that a process has stopped.

## Related contracts

- [Agent configuration](agent-configuration.md)
- [Authorization](auth-and-permissions.md)
- [Worker storage](worker-storage-layout.md)
- [Execution runtime](execution-runtime-foundation.md)
- [Sessions and Main Runner](sessions-main-runner.md)
- [Tasks and Task Runner](tasks-task-runner.md)
- [Artifacts](artifacts.md)
