# Luna

Luna is a Bun-first TypeScript workspace for an agent collaboration service.
It includes Luna Service, Dashboard, CLI/MCP, independent Workers, containerized
runners, plugins and artifact storage.

Start with the [documentation overview](docs/overview.md) for architecture or
the [deployment guide](docs/runbooks/deploy-luna.md) for Linux and systemd setup.

## Requirements

- Bun 1.3.11 or later and Git.
- Docker and a Runner image on Worker hosts.
- Provider and channel credentials for the integrations you enable.

CI installs locked dependencies, checks types, runs tests, builds the workspace
and checks CLI entrypoints. Unit tests do not verify live Docker, model-provider
or Feishu behavior. See the [release checklist](docs/releasing.md).

## Install commands

```bash
bun install --frozen-lockfile
bun run build
bun link
```

`bun link` registers `luna`, `luna-service` and `luna-worker` in Bun's global
binary directory. Ensure `~/.bun/bin` is on `PATH`.

```bash
luna version
luna service version
luna worker --help
```

`luna service` manages local Service; `luna worker` manages local Worker.
Other commands access an existing Service. Local deployment commands require
the corresponding component bundle; a client-only installation can still use
remote business commands. Remote Worker hosts do not need Service or Dashboard.

## Start Service

Before exposing the service, set a unique `LUNA_DASHBOARD_TOKEN` in
`$LUNA_HOME/.env`; `openssl rand -hex 32` can generate one. Never commit keys.
Missing, blank or public development tokens are accepted only on literal
loopback listeners. A reverse proxy exposing a loopback service still requires
a unique token and HTTPS.

Service initialization does not require Docker or select a Runner image:

```bash
luna service runtime init
luna service start --port 8090
```

Service defaults to `~/.luna`, configurable with `--home` or `LUNA_HOME`.
Non-sensitive settings belong in `config.yaml`; secrets and bootstrap values
belong in `.env`. Precedence is defaults, config file, environment file, process
environment, then CLI options. Runtime configuration defaults to
`$LUNA_HOME/runtime/runtime.json`.

```bash
luna service status
luna service stop
# Keep this attached to the terminal for foreground debugging.
luna service start --foreground --port 8090
```

Open the Dashboard at `http://127.0.0.1:8090`. Configure the Agent, its model
connection and any channels or plugins you need. Login does not automatically
grant platform administrator authority; see the deployment guide.

## Prepare and bind a Worker

```bash
./container/build.sh --variant general
luna worker init --image luna-runner:latest
# First registration when Service and Worker share a host.
luna worker bind --local --service http://127.0.0.1:8090
```

Generate a binding code on the target Agent's Workers page, then assign and start
the Worker:

```bash
luna worker bind --service http://127.0.0.1:8090
luna worker start
```

A remote Worker initializes locally, then binds directly to its Service's HTTPS
origin using the Agent's code. Worker defaults to `~/.luna-worker`;
`--home` or `LUNA_WORKER_HOME` selects another root. `worker.json` stores local
execution settings; `binding.json` stores connection identity and credentials.
Workers may use different images. Retired combined configuration formats are not
automatically migrated.

Each Worker maintains writable HOME and context directories per Agent/Shadow,
with immutable resource snapshots mounted read-only. See
[Worker storage](docs/designs/worker-storage-layout.md) and
[Runner images](container/README.md). Machine-specific Android Dockerfiles live
in the Git-ignored `container/local/` directory and are not included in a clone.

## CLI and knowledge workspace

```bash
LUNA_SERVICE_URL=http://127.0.0.1:8090 luna auth login
luna workspace knowledge read wiki/index.md
luna workspace knowledge grep "keyword" --glob "wiki/**/*.md"
```

CLI login uses a device-code flow and resolves the canonical user on Service.
Runners, CLI and MCP must not supply identity overrides or bypass authorization
through direct reads of the Service knowledge repository. Knowledge writes and
Git commits are separate explicit operations.

Service exposes Streamable HTTP MCP at `/mcp` on the same origin. Each request
uses its own authenticated Dashboard cookie or bearer token. Stdio-only clients
can use the local bridge:

```bash
LUNA_SERVICE_URL=http://127.0.0.1:8090 \
LUNA_ACCESS_TOKEN=YOUR_ACCESS_TOKEN \
LUNA_AGENT_ID=YOUR_AGENT_ID \
luna service mcp bridge --stdio
```

The bridge forwards authenticated requests; it is not a separate service daemon.
See [CLI, MCP and workspace](docs/designs/cli-mcp-workspace.md).

## Development

```bash
bun run typecheck
bun test
bun run build
```

Build outputs are in `dist/` and `apps/dashboard/dist/` and are ignored by Git.
For changes affecting runtime or Dashboard, follow the live verification rules
in [AGENTS.md](AGENTS.md).
