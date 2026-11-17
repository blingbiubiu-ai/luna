# Service and Worker storage

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
derived mount sources outside writable Shadow HOME. The mounted snapshot is
read-only at `$HOME/.luna-resources/`; HOME remains writable. Provider-specific
skill installation consumes that snapshot. Runner commands are exposed through
`.luna-resources/commands`.

Preparation records retain their resource selection until trusted Service
settlement and Job reservation release. A new resource version waits for the
old preparation references to drain before replacing the container. Persistent
Shadow files survive that replacement. Other Shadows keep their own containers
and snapshots.

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
