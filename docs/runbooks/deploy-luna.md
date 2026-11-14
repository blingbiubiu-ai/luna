# Deploy Luna

This guide covers a new Linux deployment with systemd. Examples use `/opt/luna`
for source and bundles, `/var/lib/luna` for Service home and
`/var/lib/luna-worker` for Worker home. Change commands, units and environment
settings together if you choose other paths. Host-specific configuration belongs
outside the public repository.

## Components and topology

| Component | Responsibility | Requirements |
| --- | --- | --- |
| Service | Dashboard, APIs, authorization, business data and embedded Runtime | Bun, Service bundle and Dashboard assets |
| Worker | Local execution configuration, Docker and outbound Service connection | Bun, Worker bundle and Runner image |
| Executor/Runner | Containerized execution | Included in the Runner image |

Service can run without Docker or a colocated Worker. Each Worker initializes
its own environment and binds to Service separately. Multiple Workers may use
different images. Agent Worker authorization and routing determine placement.

```text
worker init  -> worker.json: image digest, ports, directories and local settings
worker bind  -> binding.json: Service origin and connection identity
worker start -> validate both files, check local readiness and connect
```

## Prerequisites and networking

Install Git and Bun 1.3.11 or later. Worker hosts also need Docker. The example
units use `/usr/local/bin/bun`; confirm that path is executable by the service
account. Building hosts need a clean checkout and access to dependency and image
sources. Workers and containers need access to the selected model and tool APIs.

```bash
/usr/local/bin/bun --version
git --version
# Worker and image-build hosts only.
docker info
```

Create a dedicated account and writable homes, if they do not exist:

```bash
sudo useradd --system --home-dir /nonexistent --shell /usr/sbin/nologin luna
sudo install -d -o luna -g luna -m 0700 /var/lib/luna
# Worker hosts only; the docker group must already exist.
sudo usermod -aG docker luna
sudo install -d -o luna -g luna -m 0700 /var/lib/luna-worker
```

Worker uses the host account's numeric runner identity unless configured
otherwise. Its persistent directories must be writable by that identity.

| Listener | Default | Exposure |
| --- | --- | --- |
| Public HTTPS | 443 | Reverse proxy to Service, with WebSocket Upgrade support |
| Service HTTP | 8090 | Prefer loopback |
| Embedded Runtime | 8091 | Local authenticated runtime/maintenance access |
| Worker control | 8092 | Loopback |
| Linux Executor callback | Worker port + 100, normally 8192 | Local Docker network; callback-only |
| Executor control | 41000–41100 | Local host |

Worker initiates the connection to `/api/worker/connect`. Service does not need
access to remote Worker control ports. Use an HTTPS Service origin without path,
query or fragment, such as `https://luna.example.com`. Docker Desktop uses
`host.docker.internal`; Linux uses a container-reachable host gateway. Adjust
`callbackHost`/`callbackPort` if the default callback route is unsuitable.

## Build source and image

Place the intended release checkout in `/opt/luna`. Build as an account with
write access and verify the exact tag or commit:

```bash
cd /opt/luna
git status --short
git rev-parse HEAD
bun install --frozen-lockfile
bun run typecheck
bun test
bun run build
```

Outputs include `dist/luna-client.js`, `dist/luna-service.js`,
`dist/luna-worker.js` and `apps/dashboard/dist/`. Service needs its bundle and
static resources. A remote Worker can receive only its Worker bundle and final
Runner image; it does not need Dashboard or a Service process.

Build a versioned public Runner image on a Docker host:

```bash
cd /opt/luna
./container/build.sh release-001 --variant general
docker image inspect luna-runner:release-001 --format '{{.Id}}'
bash container/test-container.sh luna-runner:release-001 general
```

Machine-specific Android builds require private local files; see
[Runner images](../../container/README.md). A public clone does not include them.
To transfer the final image between hosts:

```bash
# Build host: transfer this archive to the Worker host.
docker save -o luna-runner-release-001.tar luna-runner:release-001
# Worker host
docker load -i luna-runner-release-001.tar
```

A registry is another option. `LUNA_RUNNER_IMAGE_NAME` selects the repository.
Only the final Runner image is required on the execution host.

## Configure and start Service

Generate secrets only for a new deployment; preserve existing keys during
updates. The following command refuses to overwrite an environment file:

```bash
sudo -u luna /bin/bash <<'SETUP'
set -euo pipefail
umask 077
test ! -e /var/lib/luna/.env
{
  printf 'LUNA_SERVICE_HOST=127.0.0.1\n'
  printf 'LUNA_SERVICE_PORT=8090\n'
  printf 'LUNA_DASHBOARD_TOKEN=%s\n' "$(openssl rand -hex 32)"
  printf 'LUNA_DASHBOARD_SESSION_SECRET=%s\n' "$(openssl rand -hex 32)"
  printf 'LUNA_ACCESS_TOKEN_SECRET=%s\n' "$(openssl rand -hex 32)"
  printf 'LUNA_AGENT_CONFIG_MASTER_KEY=%s\n' "$(openssl rand -base64 32)"
} > /var/lib/luna/.env
SETUP
```

The configuration master key is a Base64-encoded 32-byte key. Back it up with the
database; do not regenerate it during an update. Alternatively use
`LUNA_AGENT_CONFIG_MASTER_KEY_FILE` with an owner-readable key file. Non-secret
settings belong in `/var/lib/luna/config.yaml`; configure `service.publicUrl`
with your HTTPS address when needed.

Initialize embedded Runtime once. This does not access Docker or select an image:

```bash
sudo -u luna env HOME=/var/lib/luna LUNA_HOME=/var/lib/luna \
  /usr/local/bin/bun /opt/luna/dist/luna-service.js runtime init \
  --home /var/lib/luna --host 127.0.0.1 --port 8091
```

Existing configuration returns `configuration_exists`. Do not repeat init during
routine upgrades. Set execution resource limits and concurrency to match the
host before sending real work.

Install and start the supplied unit:

```bash
sudo install -m 0644 /opt/luna/deploy/systemd/luna.service /etc/systemd/system/luna.service
sudo systemctl daemon-reload
sudo systemctl enable --now luna.service
sudo systemctl status luna.service --no-pager
curl --fail http://127.0.0.1:8090/api/health
```

Configure an HTTPS proxy to loopback Service and forward WebSocket Upgrade.
A unique Dashboard token is required even when the service listener is loopback.
For foreground diagnosis, stop the systemd instance first and run the current
Service bundle with `--foreground`; restore the unit afterward.

Sign in to Dashboard, configure the target Agent's model, Shadows, plugins and
channels. Login does not automatically grant platform administrator authority.
For initial administration, obtain the authenticated canonical user ID from
`/api/auth/session`, then run on the Service host:

```bash
sudo -u luna env HOME=/var/lib/luna LUNA_HOME=/var/lib/luna \
  /usr/local/bin/bun /opt/luna/dist/luna-service.js admin grant \
  --home /var/lib/luna --user-id YOUR_CANONICAL_USER_ID
```

## Initialize and bind Worker

Run init on each Worker host, including colocated Workers:

```bash
sudo -u luna env HOME=/var/lib/luna LUNA_WORKER_HOME=/var/lib/luna-worker \
  /usr/local/bin/bun /opt/luna/dist/luna-worker.js init \
  --home /var/lib/luna-worker --image luna-runner:release-001
```

Init pins the local image digest and stores directories, ports, resource limits
and numeric runner identity without connecting to Service. Each Worker requires
a separate home. Init will not overwrite an existing configuration.

For a colocated Worker, first register using Service's local Runtime configuration:

```bash
sudo -u luna env HOME=/var/lib/luna LUNA_WORKER_HOME=/var/lib/luna-worker \
  /usr/local/bin/bun /opt/luna/dist/luna-worker.js bind \
  --home /var/lib/luna-worker --local --service http://127.0.0.1:8090 \
  --runtime-config /var/lib/luna/runtime/runtime.json
```

Then generate a code on the target Agent's Workers page and execute bind again
without `--local`, using the same Service origin. Local registration alone does
not assign execution access to an Agent.

Remote Workers skip local registration and redeem the Agent's binding code:

```bash
sudo -u luna env HOME=/var/lib/luna LUNA_WORKER_HOME=/var/lib/luna-worker \
  /usr/local/bin/bun /opt/luna/dist/luna-worker.js bind \
  --home /var/lib/luna-worker --service https://luna.example.com
```

Bind writes `binding.json`, does not access Docker and does not change the image.
Additional Agent assignments must use the same Service origin and existing
Worker identity. Remote Workers do not need Service databases, private Runtime
configuration or management credentials.

## Start and verify Worker

```bash
sudo install -m 0644 /opt/luna/deploy/systemd/luna-worker.service /etc/systemd/system/luna-worker.service
sudo systemctl daemon-reload
sudo systemctl enable --now luna-worker.service
sudo systemctl status luna-worker.service --no-pager
sudo -u luna env HOME=/var/lib/luna LUNA_WORKER_HOME=/var/lib/luna-worker \
  /usr/local/bin/bun /opt/luna/dist/luna-worker.js status --home /var/lib/luna-worker
```

Start validates local configuration and binding, checks Docker/image/directories,
and connects to Service. It does not repeat initialization or binding.

Verify the actual target environment:

1. Service health is normal and the Worker is online, ready and accepting work.
2. The Agent has Worker access and a successful model connection test.
3. A short real task creates a container, completes and returns a visible result.
4. A task file or artifact is readable through the normal access path.
5. Enabled channels receive and deliver a real message. Dashboard success alone
   does not establish channel integration readiness.

Placement does not automatically infer the toolchain a task needs. Use Agent
Worker authorization and Shadow routing to select an appropriate environment.

## Update, backup and rollback

Pause admission and wait for accepted work to settle before changing image or
mount configuration. Global Runtime drain is available on the Service host:

```bash
sudo -u luna env HOME=/var/lib/luna LUNA_HOME=/var/lib/luna \
  /usr/local/bin/bun /opt/luna/dist/luna-service.js runtime mode drain --home /var/lib/luna
```

Drain prevents new admission; it does not prove existing processes have stopped.
Back up SQLite with processes stopped or a reliable online backup tool. Preserve
a consistent snapshot of databases, keys, configuration, artifacts and work data.

| Data | Example locations |
| --- | --- |
| Service secrets and configuration | `/var/lib/luna/.env`, `config.yaml`, master key |
| Service business data and files | `/var/lib/luna/data/`, artifact and knowledge directories |
| Runtime configuration and state | `/var/lib/luna/runtime/` |
| Worker connection and local settings | `worker.json`, `binding.json`, `.env` |
| Worker execution and work data | `worker.sqlite*`, `agents/`, project directories |

Deploy compatible bundles and static assets, restart the affected units, then
verify listeners, health, Worker readiness and a real task before resuming.

```bash
sudo systemctl restart luna.service
# Worker host only.
sudo systemctl restart luna-worker.service
sudo -u luna env HOME=/var/lib/luna LUNA_HOME=/var/lib/luna \
  /usr/local/bin/bun /opt/luna/dist/luna-service.js runtime mode resume --home /var/lib/luna
```

Restore any Agent Worker admission settings paused for the update. To switch a
Worker image, drain and stop it, back up its data, resolve the new digest with
`docker image inspect`, update `worker.json.imageDigest` with owner-only
permissions, restart and verify. Init and bind do not replace an existing image.

Rollback must match code, database baseline, configuration and encryption keys.
Do not use `db reset --yes` as an upgrade repair: it deletes data. Retired combined
Worker configuration and Runtime image fields have no automatic migration path.
Stop and drain work before restoring a prior digest or compatible data snapshot.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| `worker_not_initialized` | Init in the selected Worker home |
| `worker_not_bound` | Bind after init; check adjacent `binding.json` |
| `configuration_exists` | Inspect existing settings; do not delete production state to repeat init |
| `worker_service_mismatch` | Use the original Service origin |
| Offline Worker | HTTPS, certificates, WebSocket proxy and outbound network |
| Unready Worker | Docker permissions, image digest and local directories |
| No task admission | Agent assignment, pause/drain, capacity and context ownership |
| Non-loopback startup rejected | Set a unique token or use loopback with a secured proxy |
| Environment changes not applied | Check the component home and restart it |

```bash
sudo journalctl -u luna.service -n 100 --no-pager
sudo journalctl -u luna-worker.service -n 100 --no-pager
sudo ss -ltnp
```
