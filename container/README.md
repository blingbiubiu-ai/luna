# Runner images

The public container files build the shared runtime and general-purpose runner:

```sh
./container/build.sh --variant general
make -C container test VARIANT=general
```

The image carries system software, provider CLIs and container scripts. The
Executor and `luna` CLI baked into it serve only Workers older than the runner
runtime mount; current Workers mount their own copies at `/opt/luna-runtime`,
so changing Luna code does not need a new image.

Machine-specific images live under `container/local/`, which is ignored by Git.
The optional Developer variant uses this local layout:

```text
container/
  Dockerfile                 # public general-purpose runner
  Dockerfile.base            # public shared runtime
  build.sh                   # public build entrypoint
  test-container.sh          # public verification entrypoint
  local/                     # private; excluded from Git
    developer/
      Dockerfile.android-base
      Dockerfile.developer
      test-container.sh
```

After supplying these local files, use the existing commands:

```sh
./container/build.sh --variant developer
make -C container test VARIANT=developer
```

The Android toolchain image is cached separately from the shared runtime.
`LUNA_REBUILD_ANDROID_BASE=1` forces a toolchain rebuild. The private Dockerfiles
can include internal download sources and host-specific SDK aliases. Keep those
values in `container/local/`; public build scripts and documentation should
contain only generic configuration. Developer builds require `linux/amd64`.
A fresh clone without the local files reports a missing-configuration error
before invoking Docker. General-purpose builds do not require the local files.
