# Service and Worker storage

Worker model providers add immutable code under `plugins/releases/<plugin>/<digest>`, private child
HOME under `agents/<agent>/model-providers/<plugin>`, and a 0600 key at
`model-provider-secrets/master.key`. Account ciphertext, immutable revisions and grant hashes are
Worker-owned SQLite records; these directories are never Runner mounts. Service stores masked
account references only. See [Worker Model Providers](worker-model-providers.md).

Service defaults to `~/.luna`; Worker defaults to `~/.luna-worker`. Local and
remote Workers use the same configuration and binding model. Service does not
scan Worker files, and Worker startup does not read Service-private directories.

## Directory ownership

| Location | Owner and contents |
| --- | --- |
| Service `data/` | Business database and Service-owned state |
| Service `runtime/` | Runtime configuration, scheduling state and Worker registrations |
| Worker `worker.json` | Local image digest, ports, directories, resources and runner identity |
| Worker `binding.json` | Service origin, Runtime/Worker identity and control credentials |
| Worker `worker.sqlite` | Execution, preparation and local lifecycle state |
| Worker `agents/<agentId>/shadows/<shadowId>/` | Persistent writable Shadow HOME |
| Shadow HOME `runners/` | Separate working directories for session and task contexts |
| Worker `agents/<agentId>/shadow-resources/<shadowId>/` | Controlled resource snapshots, mount sources and Executor credentials |
| Resource directory `environments/<envId>/executor.json` | Executor configuration mounted read-only at `/run/luna/executor.json` |
| Worker project directories | Host project paths configured for that Worker |

Worker resolves physical paths from its own configuration and persistent Shadow
layout. Context paths remain bound to their original Shadow; missing historical
HOME or context directories fail instead of silently creating empty replacements.
Service stores logical execution ownership and Worker-returned path metadata.
Service and Worker paths do not need to match.

## Configuration and binding

Worker home is selected by `--home`, `LUNA_WORKER_HOME`, then `~/.luna-worker`.
An explicit `--config` can select the local configuration file; `binding.json`
lives beside it. Worker loads its own environment and local settings.

`worker init` creates local settings without connecting to Service.
`worker bind` requires initialization and writes connection identity separately.
`worker start` requires both files and combines them in memory. Image changes
must update the Worker's local settings while execution is drained; binding does
not select or replace an image.

Explicit local pairing uses `bind --local` and reads Service Runtime management
configuration once. The Worker must then be assigned to an Agent using its
binding code. Remote Workers use an Agent binding code directly. Subsequent
assignments preserve Worker identity and must use the same Service origin.

## Scoped resource snapshots

Service pins an immutable resource selection to each invocation before issuing
execution credentials. Snapshots separate public resources and Agent tools;
Agent memory and Shadow persona stay in Service. Content digests include ownership scope
where required; a digest does not replace authorization.

Worker downloads only the snapshot authorized for its placement and verifies
scope, digest, file types and path boundaries. It stores versioned bundles and
derived mount sources outside writable Shadow HOME. The Shadow's derived versions
are mounted read-only at `$HOME/.luna-resource-versions/`, and
`$HOME/.luna-resources` links to the selected one; HOME remains writable. Provider-specific
skill installation consumes that snapshot. Runner commands are exposed through
`.luna-resources/commands`.

Preparation records retain their resource selection until trusted Service
settlement and Job reservation release. A Shadow always runs its newest version:
the version first prepared most recently on the Worker. Preparing a new version
does not wait for older preparations, and its first Job switches the link without
replacing the container while older Jobs keep running; versions are never deleted,
so files those Jobs hold open stay readable. Only another placement of the Shadow
waits for the previous one to be released (`shadow_resources_pending`). Other
Shadows keep their own containers and snapshots.

While the container runs, Worker switches the link from inside it (`docker exec` as the
Runner user). Docker Desktop's file sharing keeps serving a symlink the host replaced, so
reads through a host-switched link fail with EINVAL; a stopped container is switched on
the host and sees the new link when it starts.

Deleting a Shadow (or its Agent) removes its Worker data for good once its work has
drained: every environment's container, `/data` volume and record, the Shadow HOME
(`agents/<agent>/shadows/<shadow>`) and its resource directory
(`agents/<agent>/shadow-resources/<shadow>`), plus its layout, context and preparation
records. Service then forgets the Shadow's placement. Disabling keeps all of it. Service
keeps the Shadow's sessions, messages, tasks and memories. A Worker that cannot be reached
keeps the delete pending until it returns; Shadows deleted before this rule are found by
their remaining placement and purged by a once-a-minute sweep. Files container root left
in HOME are removed through a short-lived root container.

Deleting an Executor environment removes its associated credential directory.
Snapshot retention and cleanup follow execution ownership and reference rules;
private resource directories must never be mounted as a shared parent tree.

## Database initialization

Service accepts the current initial database baseline. It does not provide
automatic conversion of retired deployment formats. See
[Database schema](database-schema.md), [Execution runtime](execution-runtime-foundation.md)
and the [deployment guide](../runbooks/deploy-luna.md).

## Primary code paths

- `apps/worker/src/cli.ts`
- `apps/worker/src/config.ts`
- `apps/worker/src/shadow-layout.ts`
- `apps/worker/src/shadow-preparation.ts`
- `apps/worker/src/shadow-preparation-store.ts`
- `apps/worker/src/shadow-mounts.ts`
- `apps/worker/src/resource-download.ts`
