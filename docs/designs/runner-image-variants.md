# Runner image variants

Both final runner images inherit `container/Dockerfile.base`, tagged as
`luna-runner-base:TAG`. This shared base contains Node 22 slim, Bun, the Luna
client, Executor, Claude/Codex CLIs, Python, general development utilities,
Chrome, the runner user, directory layout and entrypoint. These components
are defined and built once.

`container/Dockerfile` is a thin general-purpose child of that base. It does
not install Android SDK, NDK, JDK or Gradle archives.
`container/local/developer/Dockerfile.developer` inherits the same base, installs JDK 17,
native build dependencies, remote device CLI tools (`bdc`, `hdc`), media/archive utilities, and copies SDK/NDK/CMake and preloaded Gradle
archives from the separately cached `container/local/developer/Dockerfile.android-base` image. That
image is only an asset source, not the Developer runner's runtime parent.
This keeps large downloads cached when the shared runtime changes.
Developer Dockerfiles and their verification script live under the Git-ignored
`container/local/developer/` directory. They are local deployment assets and may
include private Gradle distributions, device CLI binaries, and SDK path aliases. Public entrypoints
select these files only for the Developer variant and fail with a clear message
when they are absent; general builds do not require them.
Both variants inherit the same Executor entrypoint and Worker mount/protocol
contracts. The build script defaults to linux/amd64; Developer requires it.

Build from the checkout root:

```sh
./container/build.sh --variant general
./container/build.sh --variant developer
```

The optional positional argument selects a tag. `make -C container build
VARIANT=general|developer` uses the same script and the repository root build
context. The shared base is rebuilt each invocation using Docker layer caching;
`LUNA_RUNNER_BASE_IMAGE` overrides its tag. The Android toolchain source is built only for Developer and reused unless
`LUNA_REBUILD_ANDROID_BASE=1`. General is the default. Separate image names
allow both variants to coexist. `LUNA_RUNNER_IMAGE_NAME` overrides the repository
name; `LUNA_RUNNER_PLATFORM` selects the Docker platform.

## Worker-owned image selection

Service Runtime initialization does not use Docker or accept image options:

```sh
luna service runtime init
```

Each Worker resolves and stores its own image digest during local init:

```sh
luna worker init --image luna-runner:latest
luna worker init --image luna-runner-developer:latest
```

After initialization, connect it to Service separately:

```sh
luna worker bind --service https://YOUR_SERVICE
luna worker start
```

`worker.json` stores only local execution settings: image digest, optional `imageRef` / `imageVariant`, directories,
ports, resources and numeric runner identity. `binding.json` stores Worker ID,
Runtime ID, Service origin and control token. Init does not connect to Service;
bind requires initialization and never invokes Docker or changes worker.json.
Start/status require both files and assemble the in-memory WorkerConfig.
Old combined Worker files are rejected; no migration or compatibility path exists.

## One-click deployment and console upgrade

Service exposes read-only Worker distribution endpoints under `/api/worker/`:
- `GET /api/worker/install.sh`: POSIX/bash bootstrap script that verifies Docker, installs Bun if absent, pulls the selected variant image, downloads and SHA-256 verifies `luna-worker.js` into `<worker-home>/bin/releases/<version>/` with a `bin/current` symlink and rollback-aware launcher (`bin/luna-worker-run.sh`), initializes and binds the Worker, and registers a `systemd` (Linux) or `launchd` (macOS) daemon.
- `GET /api/worker/release/manifest.json`: publishes the Service's bundled `luna-worker.js` version/SHA-256 and default `general` / `developer` image references (overridable via `LUNA_WORKER_IMAGE_GENERAL` / `LUNA_WORKER_IMAGE_DEVELOPER`).
- `GET /api/worker/release/luna-worker.js`: serves the Service's `luna-worker.js` bundle with `x-luna-worker-sha256` and `x-luna-worker-version` headers.

The Agent Workers Dashboard dialog generates a one-click `curl ... | bash` command with a single-use binding code and selected variant, while keeping manual binding available for existing Workers.

Workers advertising the `worker-upgrade-v1` capability report `workerVersion`, `imageRef`, `imageVariant`, `managedBinary` and live `upgrade` status in heartbeats. The Worker's owner (or a platform administrator owning the Agent for the local Worker) can trigger an upgrade from the Dashboard (`POST /api/agents/:agentId/workers/:workerId/upgrade`), which forwards `POST /v1/upgrade` over the reverse WebSocket channel. The Worker pulls the latest `imageRef` in the background, updates `worker.json` and its in-memory `imageDigest` (so idle containers replace on next admission without interrupting active Jobs), and—for managed installations—downloads and SHA-256 verifies the newer `luna-worker.js`, atomically swaps `bin/current` (preserving `bin/previous` for launcher rollback), and exits cleanly so the host supervisor restarts it on the new version.

Worker heartbeat reports its digest and local readiness. The Service handshake
requires protocol version 2 and does not specify an image. Placement checks
Agent authorization, protocol capability, projects, readiness and capacity;
it does not require matching images across Workers. Job and file preparation
requests carry the owning Worker's reported digest. Worker checks that digest
against its own configuration before starting Docker. Existing context affinity
continues to hold; having different toolchains does not move existing contexts.

RuntimeConfig has no imageDigest field. Old Runtime config fields and old
handshake image fields are rejected rather than migrated. Changing a Worker's
image requires stopping/draining its work, updating its worker.json digest and
restarting that Worker; bind does not overwrite existing Worker configuration.
Service does not automatically match Jobs to Developer versus general toolchains;
Agent Worker authorization and placement determine which environment runs a Job.

Validate the chosen image with `container/test-container.sh IMAGE general|developer`.
General checks the provider/runtime tools and absence of Android SDK; Developer
also checks the JVM, SDK, NDK, remote device CLI tools, and preloaded project toolchains.
