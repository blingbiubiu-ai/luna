# Runner Sandbox

Claude and Codex Main, Work, and Task Runners all execute through [Runtime, Worker and Executor](execution-runtime-foundation.md). Service submits and observes Jobs. Worker owns Docker and the runner image. The container starts Executor, which launches a new Runner subprocess for each attempt.

Each Worker runs one Executor container and maintains one local HOME per Shadow. Contexts assigned to the same Worker and Shadow share that HOME and keep individual working directories and provider session IDs. A Shadow can use multiple Workers when new contexts need capacity.

## Host identity and project access

Worker uses its host account UID and GID for all Runner subprocesses. The deployment can specify `runnerUid` and `runnerGid` for the whole Worker. Executor remains root with restricted capabilities. Runner subprocesses start without capabilities or supplementary groups.

Projects remain on the host. Project IDs identify context affinity. Runners work in the Shadow HOME and their context directories.

Runner processes in a Shadow use the same UID and share its HOME. Executor control credentials and its SQLite ledger are root-owned. Job-scoped Service tokens are passed through each Runner process environment.

## Files and tools

Worker resolves a Shadow’s HOME on its host (`agents/<agentId>/shadows/<shadowId>/` under the Worker home) and mounts it at `/home/luna` in the container; each container belongs to one Shadow, so this path is the same in every container. Its `runners/` directory is part of that mount. Worker writes and reads the host directory and hands Executor, Service and the owner only `/home/luna` paths; the preparation reply also carries `hostCwd`, which Service uses only when it shares the Worker's host (local plugins and artifacts). Executor gives the Runner UID the account `luna` with this HOME, so shells show `luna@…`. Worker prepares the following additional mounts.

| Source | Container target | Access |
| --- | --- | --- |
| The Shadow's published snapshot versions | `$HOME/.luna-resource-versions` | Read-only |
| Executor configuration | `/run/luna/executor.json` | Read-only |
| Executor Docker volume | `/data` | Read/write |

The snapshot contains `skills/`, `commands/`, `prompts/`, and `tools/`. Agent memory and Shadow persona are not in it; Service serves them through `luna memory` ([Agent memory](agent-memory.md)). Claude loads the Luna Skills plugin with `--plugin-dir`. Codex installs it from the snapshot’s local marketplace. User Skills remain in each provider’s writable user directory. The command directory and `$HOME/.local/bin` are on PATH.

Worker generates instructions from the snapshot’s `prompts/` templates and its own mount layout. Service supplies dynamic `.luna/runner-context.json` content during execution preparation; Worker writes it in its local Runner directory. The preparation response carries the container paths and a hash of the generated instructions. Worker validates the resolved directory against its configured Runner root and records the context-to-directory binding. Executor sets `HOME` and `LUNA_HOME` to the public home, `LUNA_RUNNER_HOME` and `cwd` to the session/task directory. For session A, the default working directory is `/home/luna/runners/session-A`. Artifacts and working files use its `workspace` child. Main, Work and Task instruction files include these paths and direct shared-resource access through HOME.

Executor passes `LUNA_ACCESS_TOKEN`, `LUNA_SERVICE_URL` and invocation metadata in the per-attempt Runner environment for `stdio` Jobs, or through a per-context `0600` `LUNA_TURN_ENV_FILE` on `/tmp` (`tmpfs`) for warm `pty` sessions (forwarded to Codex shell tools via `shell_environment_policy.set.LUNA_TURN_ENV_FILE` and wiped on turn completion or cancellation). CLI uses environment-first credential resolution with `LUNA_TURN_ENV_FILE` overlaid on top of static process environment. A retry reads the latest supplied credentials. Executor holds credentials in memory for queued/retried Jobs and clears them at terminal state. Container restart interrupts unfinished Jobs; credentials are not persisted. Public command scripts launch the CLI directly.

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
used: development builds bundle the Bun entrypoints into the Worker, which mounts
them into containers (see execution-runtime-foundation.md); the Executor's Job
entry defaults to the `job-main.js` beside it. Image toolchains remain
available; this initialization connects them to the persistent HOME.

`$HOME/.luna-resources` is a link Worker points at the selected version
(`.luna-resource-versions/<digest>`). Worker re-asserts it whenever it reuses or
creates the container, so a Runner edit lasts at most until the next Job.

## Container reuse and the system disk

The container's root filesystem is writable: a container is used like a computer
whose system disk (packages installed with apt from a root terminal, files outside
HOME) persists across Jobs, container restarts, Docker restarts, snapshot changes
and limit changes. HOME is the data disk and is kept forever. Jobs run as the
Runner UID; only a Dashboard root terminal, or a Job granted root (see
[Shadow root access](#shadow-root-access)), changes system directories.

Worker labels new containers with a hash of their Docker launch arguments and
Executor configuration. Matching running containers are reused; matching stopped
containers are started in place, preserving the container ID and its writable layer.
The hash covers the image, mounts and access modes, network/ports, security
settings and Executor parameters, but not the contents of HOME, projects or working
directories, the snapshot version or resource limits:

- **A new snapshot** (Skills, commands, prompts, tools) switches the
  `.luna-resources` link once the Shadow has no reservation; running Jobs keep the
  version they were admitted with. Executor admits a Job only when the link names
  the Job's snapshot digest.
- **Changed limits** (memory, CPUs, pids) are applied with `docker container update`
  once the Shadow is idle.
- **A new image** or **a changed Shadow root switch** replaces the container after
  reservations, Executor Jobs and active console streams settle: this resets the
  system disk, as do configuration changes of the launch arguments themselves and
  legacy containers without the label. File maintenance never changes the root switch.
- **Reset system disk** in the Dashboard closes open console streams and removes the
  container (refused while Jobs run); the next Job or console recreates it from the
  image.

Persistent host directories and the Executor data volume survive replacement;
`/tmp` is a tmpfs and is cleared whenever the container stops.

## Dashboard container access

The Dashboard Containers page lists an Agent's Shadow containers on its assigned
Workers, plus active Shadows whose container has not been created yet, and opens a
terminal, a root terminal or a desktop (VNC) in one of them. Only the Agent owner
can do so. Unprovisioned Shadows can be provisioned on demand (`POST /api/agents/:agentId/containers`)
before any Job runs, placing the Shadow on an assigned Worker and publishing its
current resource snapshot so subsequent Jobs reuse the same container. Opening a
stopped container starts it first; draining or replacing environments are refused.
Active console streams keep the environment marked non-idle and defer background
container replacement until the streams close; explicit system-disk reset closes
them immediately.

- **Terminal** runs `docker exec -it` in a Worker-local PTY as the Runner UID,
  with `HOME` and `cwd` set to the Shadow HOME. Logins made here (gh, ssh, git)
  are files Jobs can read.
- **Root terminal** uses `docker exec -u 0` with `HOME=/tmp` and requires the same
  host `nosuid` check as Shadow root access (`rootHostCheck`). apt works here, and
  what it installs stays until the image is upgraded or the system disk is reset.
  When the session ends, Worker runs `luna-home-sanitize` in the container to clear
  setuid/setgid bits and restore any non-Runner file ownership in the Shadow HOME.
- **Desktop** runs `luna-desktop start` as the Runner: Xvfb, openbox with a tint2
  panel (Chrome and terminal launchers, window list, clock) and x11vnc (`-xkb`) on
  container-local `127.0.0.1:5900`; `luna-desktop bridge` then pipes the RFB bytes,
  and the Dashboard provides an RFB clipboard toolbar for pasting passwords, URLs
  and CJK text. `luna-desktop stop` (`POST .../desktop/stop`) terminates the X11
  session and desktop Chrome so Jobs can reuse `$HOME/.config/google-chrome` without
  profile lock conflicts. No application starts automatically. The right-click menu's
  应用程序 submenu is generated from `.desktop` entries in `/usr/share/applications`,
  `/usr/local/share/applications` and `~/.local/share/applications`, so software
  that ships an entry, or an entry a Shadow adds to its HOME, appears there.
  `/usr/local/bin/google-chrome` wraps Chrome/Chromium for the container
  (`--no-sandbox`, no first-run prompts, clearing a profile lock left by a replaced
  container); absolute `/usr/bin/google-chrome` used by Jobs is unaffected (official
  Chrome on `amd64`, Debian Chromium symlinked at `/usr/bin/google-chrome` on
  `arm64`). A managed policy hides the `--no-sandbox` banner. The desktop terminal
  (lxterminal) runs a login shell.
- Runner UIDs have no passwd entry in the image; `/etc/profile.d/luna-prompt.sh`
  shows `runner` in the prompt instead of `I have no name!`.

Data path: browser WebSocket → Service → dedicated Worker data WebSocket →
`docker exec`. Service asks the Worker over its control link (`stream.open`
with a one-time token, only to Workers advertising `container-streams-v1`); the
Worker then dials `/api/worker/streams/<id>` outbound with its credential and the
token, so stream bytes never queue behind Job traffic and no inbound port is
opened. Service sends periodic RFC 6455 WebSocket Ping frames to keep idle streams
alive across its socket idle timeout without injecting application frames. Binary
frames carry bytes; text frames carry `resize` (Service → Worker) and `end` reasons
(Worker → Service). The browser socket requires the Dashboard cookie and a
same-origin `Origin`. Service logs one `container_console_session` line at start
and end (user, Agent, Shadow, Worker, environment, kind, user, duration, reason);
there is no audit table.

## Shadow root access

Each Shadow has a root switch (off by default), set by the Agent owner on the
Digital Shadows page and stored in `shadow_root_access`. Who is trusted is per
Agent: the owner, plus anyone granted the built-in `agent.root` operation on the
Users or Groups pages (directly or through a group; a deny wins; grants can
expire). Trust is ordinary authorization data, so a user's root trust appears with
their other grants.

- **Container.** With the switch on, Service marks the Shadow's `EnvironmentSpec`
  with `rootAccess`. Worker then launches the container without
  `no-new-privileges` and tells Executor `runnerSudo`; Executor adds an account for
  the Runner UID and a `#<uid> ALL=(ALL) NOPASSWD:ALL` sudoers rule at start.
- **Host check.** Root in the container can plant setuid files in the
  bind-mounted HOME. On Linux those are host files, so Worker allows root only when
  the HOME's filesystem is mounted `nosuid` (`findmnt`); Docker Desktop (macOS)
  maps container root to the host user and is allowed; other hosts are refused.
  A refused switch keeps the container without sudo, blocks root terminals, and
  shows 「root 未生效」 with the reason on the Shadow card. Worker start logs a
  warning with the mount commands when its data root is not `nosuid` (see the
  deployment runbook); existing containers need a system-disk reset afterwards.
- **Jobs.** With the switch on, every Job of the Shadow carries `rootAccess` so the
  container is not recreated per turn, while Service sets `privileged: true` only
  when the invocation's actor or at least one user-message sender in the turn is
  trusted (`ShadowRootAccessStore.invocationPrivileged`). Executor starts a
  `privileged` Runner with `setpriv` keeping the bounding set and without
  `--no-new-privs`; untrusted turns omit `privileged` and keep
  `--bounding-set=-all --no-new-privs`, blocking `sudo` in the kernel.
- **Judgement within privileged turns.** When a turn is `privileged`, whether to
  use sudo is the Runner's decision, guided by `prompts/runner-root-access.md`,
  which Worker appends to Runner instructions when the switch is on and the host
  allows it. The Runner acts like a colleague with admin rights: only trusted people
  authorize root actions, checked with `luna root status --user <userId>` (the
  Shadow comes from the runner token; grants themselves are not exposed) against the
  sender ids in its input. It goes ahead when a trusted person clearly wants the
  result, and otherwise asks in plain terms ("I'm going to install ffmpeg, OK?")
  without mentioning root; any natural agreement from a trusted person is enough
  (and their reply runs in a `privileged` turn). It never uses root for credentials,
  sudo rules or accounts, other processes, or breaking the environment.
- **HOME cleanup.** After a privileged Job, and when the container starts, Executor
  runs `luna-home-sanitize` like the root terminal does.

Container root shares the container namespace with Executor: prompt injection
through untrusted messages, web pages, files or a HOME shared by all of the
Shadow's sessions can still mislead a trusted turn into misusing `sudo`. Keep root
Shadows away from conversations with untrusted members, or give trusted users
their own Shadow with root.

## Process lifecycle

Executor supports two Runner execution drivers behind the same `job-process.js` Linux subreaper and `setpriv` privilege boundary:

- **`stdio` (default):** Feeds each attempt's input over stdin/argv to a one-shot provider subprocess and parses structured stdout JSONL inside the container, cleaning up all descendants before publishing terminal state or retrying.
- **`pty`:** Maintains a per-context warm unprivileged `pty-main.js` host (`Bun.spawn(..., { terminal })` + `@xterm/headless` viewport + `PtyIdleDetector` + native JSONL transcript/rollout bridge + `TranscriptTerminalSettle`). Warm hosts are keyed by `(runnerType, model, privileged, resourceRevision, staticEnv)`: any change in `privileged` (for example between a trusted turn and an untrusted turn in a group session), model, snapshot version, or provider environment tears down and sanitizes the previous host before spawning a replacement with `--resume`. Cancelling a turn sends TUI interrupt (`ESC` / `Ctrl-C`) with a bounded fallback to `SIGTERM` on the subreaper; idle warm hosts expire automatically according to the Agent's configured `pty.idleTimeoutMinutes` in `agent_settings` (default 10 minutes; `0` keeps the TUI resident until container restart, and updates apply in place via `/v1/pty-sessions/idle-timeout`) without blocking container idle checks (`activeJobs`). Retry and cancellation affect the original Job. Each warm host also keeps a bounded 256 KiB raw PTY replay buffer and exposes Worker-authenticated inspection and live attachment endpoints (`/v1/pty-sessions`, `/v1/pty-sessions/:contextId/stream`, `/v1/pty-sessions/:contextId/control`), bridged to the Dashboard TUI Workbench (`/$agentId/terminals`) over `CONTAINER_STREAM_PATH` (`kind: "pty"`). Attached TUI streams open read-only by default in `ContainerConsoleSession` and only forward keystrokes and resizes when the owner explicitly takes input control (`{ type: "mode", writable: true }`).

Executor posts execution events to Runtime over HTTP. Service consumes the embedded Runtime's async event iterator and handles business settlement. Worker prepares containers and releases reservations after terminal verification.

Executor and container-side Runner sources live in `apps/executor`. Build with
`bun run --cwd apps/executor build`; shared framing and failure types belong to
`@luna/runner-protocol`. The Dockerfile in `container/` installs a minimal
workspace and bundles Executor without root Service sources. User-facing Luna
CLI source lives in `apps/cli`; the Worker mounts its bundled client at
`/opt/luna-runtime/current/luna-client.js`, and the image keeps a copy at
`/app/luna-cli/cli.js` for older Workers.

Worker renders instructions from the selected resource snapshot. Remote Service URLs are preserved; only loopback URLs are rewritten to the local Docker host gateway.

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
