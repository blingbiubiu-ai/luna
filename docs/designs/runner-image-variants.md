# Runner image variants

Both final runner images inherit `container/Dockerfile.base`, tagged as
`luna-runner-base:TAG`. This shared base contains Node 22 slim, Bun, the Luna
client, Executor, Claude/Codex CLIs, Python, general development utilities,
Chrome, the runner user, directory layout and entrypoint. These components
are defined and built once.

`container/Dockerfile` is a thin general-purpose child of that base. It does
not install Android SDK, NDK, JDK or Gradle archives.
`container/local/android/Dockerfile.android` inherits the same base, installs JDK 17 and
native build dependencies, and copies SDK/NDK/CMake and preloaded Gradle
archives from the separately cached `container/local/android/Dockerfile.android-base` image. That
image is only an asset source, not the Android runner's runtime parent.
This keeps large downloads cached when the shared runtime changes.
Android Dockerfiles and their verification script live under the Git-ignored
`container/local/android/` directory. They are local deployment assets and may
include private Gradle distributions and SDK path aliases. Public entrypoints
select these files only for the Android variant and fail with a clear message
when they are absent; general builds do not require them.
Both variants inherit the same Executor entrypoint and Worker mount/protocol
contracts. The build script defaults to linux/amd64; Android requires it.

Build from the checkout root:

```sh
./container/build.sh --variant general
./container/build.sh --variant android
```

The optional positional argument selects a tag. `make -C container build
VARIANT=general|android` uses the same script and the repository root build
context. The shared base is rebuilt each invocation using Docker layer caching;
`LUNA_RUNNER_BASE_IMAGE` overrides its tag. The Android toolchain source is built only for Android and reused unless
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
luna worker init --image luna-runner-android:latest
```

After initialization, connect it to Service separately:

```sh
luna worker bind --service https://YOUR_SERVICE
luna worker start
```

`worker.json` stores only local execution settings: image digest, directories,
ports, resources and numeric runner identity. `binding.json` stores Worker ID,
Runtime ID, Service origin and control token. Init does not connect to Service;
bind requires initialization and never invokes Docker or changes worker.json.
Start/status require both files and assemble the in-memory WorkerConfig.
Old combined Worker files are rejected; no migration or compatibility path exists.

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
Service does not automatically match Jobs to Android versus general toolchains;
Agent Worker authorization and placement determine which environment runs a Job.

Validate the chosen image with `container/test-container.sh IMAGE general|android`.
General checks the provider/runtime tools and absence of Android SDK; Android
also checks the JVM, SDK, NDK and preloaded project toolchains.
