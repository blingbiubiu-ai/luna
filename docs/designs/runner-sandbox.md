# Runner Sandbox

Claude and Codex Main, Work, and Task Runners all execute through [Runtime, Worker and Executor](execution-runtime-foundation.md). Service submits and observes Jobs. Worker owns Docker and the runner image. The container starts Executor, which launches a new Runner subprocess for each attempt.

Each Worker runs one Executor container and maintains one local HOME per Shadow. Contexts assigned to the same Worker and Shadow share that HOME and keep individual working directories and provider session IDs. A Shadow can use multiple Workers when new contexts need capacity.

## Host identity and project access

Worker uses its host account UID and GID for all Runner subprocesses. The deployment can specify `runnerUid` and `runnerGid` for the whole Worker. Executor remains root with restricted capabilities. Runner subprocesses start without capabilities or supplementary groups.

Projects remain on the host. Project IDs identify context affinity. Runners work in the Shadow HOME and their context directories.

Runner processes in a Shadow use the same UID and share its HOME. Executor control credentials and its SQLite ledger are root-owned. Job-scoped Service tokens are passed through each Runner process environment.

## Files and tools

Worker resolves a Shadow’s HOME and mounts it at the same absolute path inside the container. Its `runners/` directory is part of that mount. Worker prepares the following additional mounts.

| Source | Container target | Access |
| --- | --- | --- |
| Fixed Shadow resource snapshot | `$HOME/.luna-resources` | Read-only |
| Executor configuration | `/run/luna/executor.json` | Read-only |
| Executor Docker volume | `/data` | Read/write |

The snapshot contains `memory/`, `config/`, `skills/`, `commands/`, `prompts/`, and `tools/`. Claude loads the Luna Skills plugin with `--plugin-dir`. Codex installs it from the snapshot’s local marketplace. User Skills remain in each provider’s writable user directory. The command directory and `$HOME/.local/bin` are on PATH.

Worker generates instructions from the snapshot’s `prompts/` templates and its own mount layout. Service supplies dynamic `.luna/runner-context.json` content during execution preparation; Worker writes it in its local Runner directory. The preparation response carries the instruction fingerprint and container paths. Worker validates the resolved directory against its configured Runner root and records the context-to-directory binding. Executor sets `HOME` and `LUNA_HOME` to the public home, `LUNA_RUNNER_HOME` and `cwd` to the session/task directory. For session A, the default working directory is `$HOME/runners/session-A`. Artifacts and working files use its `workspace` child. Main, Work and Task instruction files include these paths and direct shared-resource access through HOME.

Executor passes `LUNA_ACCESS_TOKEN`, `LUNA_SERVICE_URL` and invocation metadata in the per-attempt Runner environment. CLI uses its existing environment-first credential resolution. A retry reads the latest supplied credentials. An already running provider process keeps the token injected at launch and is bounded by its validity. Executor holds credentials in memory for queued/retried Jobs and clears them at terminal state. Container restart interrupts unfinished Jobs; credentials are not persisted. Public command scripts launch the CLI directly.

The runner image provides the Luna client, provider CLIs, Bun, Node and browser/development utilities. The optional Android variant also includes the Android/JVM toolchain. Knowledge Workspace is owned by Service and accessed through its API. Historical context-volume data can be exported explicitly if needed. New execution uses the host Runner directories.

## Runner environment initialization

Before launching a provider CLI, `job-main` initializes the effective Job environment
as the Worker UID. All Runner kinds use this same path.
It restores the former shell entrypoint setup: npm global packages and their PATH
under `$HOME/.npm-global`, explicit Gradle/Kotlin Native/Android cache directories,
links to the image's three preloaded Gradle Wrapper archives, and RemoteX's fswatch
link. Explicit per-Job cache and npm-prefix overrides are preserved. Existing files
and links are never replaced; concurrent Jobs can initialize the same HOME.

Git receives the process-scoped `safe.directory=*` setting. Worker and Executor
create their own directories with the configured UID.

The old stdin/IPC Node entrypoint is replaced by Executor and its Bun subprocesses.
The former startup-time compilation of a mounted Node Runner source tree is not
used: development builds must bundle the Bun entrypoints and rebuild the image (or
explicitly supply the Executor's configured `runnerEntry`). Image toolchains remain
available; this initialization connects them to the persistent HOME.

## Container reuse

Worker labels new containers with a hash of their Docker launch arguments and
Executor configuration. Matching running containers are reused; matching stopped
containers are started in place, preserving the container ID. The hash covers the
image, mounts and access modes, network/ports, resource/security settings and
Executor parameters, but not the contents of HOME, projects or working directories.
Changed configurations and legacy containers without this label require replacement.
Running containers are replaced only after reservations and Executor Jobs settle.
Image changes still follow Runtime environment configuration and drain rules.
Persistent host directories and the Executor data volume survive replacement;
`/tmp` is temporary even when the same container is restarted.

## Process lifecycle

Executor feeds the subprocess input over stdin and parses structured stdout inside the container. A per-attempt Linux subreaper owns the Runner process tree and cleans up descendants, including detached descendants, before Executor publishes the terminal state or retries. Retry and cancellation affect the original Job.

Executor posts execution events to Runtime over HTTP. Service consumes the embedded Runtime's async event iterator and handles business settlement. Worker prepares containers and releases reservations after terminal verification.

Executor and container-side Runner sources live in `apps/executor`. Build with
`bun run --cwd apps/executor build`; shared framing and failure types belong to
`@luna/runner-protocol`. The Dockerfile in `container/` installs a minimal
workspace and bundles Executor without root Service sources. User-facing Luna
CLI source lives in `apps/cli`; its bundled client remains `/app/luna-cli/cli.js`
in the image. Container entry points and mounts are unchanged.

Worker renders instructions from the fixed resource snapshot. Remote Service URLs are preserved; only loopback URLs are rewritten to the local Docker host gateway.

## Runner image variants

Both `container/Dockerfile` (general-purpose `luna-runner:latest`) and
`container/Dockerfile.android` (`luna-runner-android:latest`) inherit
`container/Dockerfile.base`. It owns Node, Bun, Chrome, provider CLIs, the Luna
client, Executor, runner user and entrypoint. Android adds JDK/native build
packages and copies SDK/NDK/CMake and Gradle archives from the cached
`Dockerfile.android-base` asset source. The shared runtime is maintained once;
large Android downloads remain cached separately.
Build with `container/build.sh [TAG] --variant general|android` or
`make -C container build VARIANT=android`. General is the default; Android requires
linux/amd64. Image names are distinct so building one does not replace the other.

Each Worker chooses its image with `luna worker init --image IMAGE` and
stores the resolved digest in worker.json. Runtime initialization does not use
Docker or store an image. Heartbeats report the Worker digest; Job/file requests
use the owning Worker's digest and Worker validates it against local config.
Readiness and placement require protocol capability, authorization, project
support and capacity, not matching digests across Workers. Old Runtime image
fields and old handshake image fields are rejected without compatibility logic.

Local execution settings are persisted in worker.json. Connection identity is
persisted separately in binding.json by worker bind --service URL. Init works
without Service; bind requires init, never checks Docker or changes execution
settings. Start/status require both files. Old combined files are not supported.
