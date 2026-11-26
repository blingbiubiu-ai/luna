# External Model Gateway Deployment

Magpie is an optional model gateway deployed independently of Luna. It owns
upstream provider accounts, model routing, and gateway API keys. Luna and other
API clients use its endpoints as an external service; its lifecycle does not
change the Luna service, Worker, or Executor lifecycle.

## Listeners And Access

The internal deployment supports both a domain-based API endpoint and a direct
IPv4-address-and-port endpoint:

| Entry | Routing | Authentication |
| --- | --- | --- |
| Management domain | Caddy to the loopback-only Magpie web listener | Magpie web login |
| API domain | Caddy's existing model-route allowlist to the web listener | Enabled gateway API key |
| Internal host IPv4 and gateway port | Directly to Magpie's gateway listener | Enabled gateway API key for remote clients |

The gateway listener binds to `0.0.0.0` on its existing port, retaining loopback
access while allowing internal IPv4 clients. The web listener and Caddy's admin
listener remain loopback-only. Caddy retains its existing interface binding and
domain routes; direct gateway access needs no additional Caddy site.

Magpie enables authenticated remote API access when its local-network sharing
setting is enabled or `MAGPIE_ADDR` explicitly binds the gateway beyond
loopback. This deployment uses the explicit listener address. Clients send
`Authorization: Bearer <gateway-key>` or `x-api-key`.
Web login cookies do not substitute for a gateway API key. Magpie owns these
access checks, including the distinction between local and remote callers.

The direct API base is `http://<internal-host-ip>:<gateway-port>`. OpenAI-compatible
clients append `/v1`; Anthropic-compatible clients configure the base without
`/v1`. These internal endpoints use HTTP under the current deployment policy.

## Configuration And Verification

The dedicated Magpie systemd service reads its environment file, including
`MAGPIE_ADDR`, and its service user's settings directory. Listener changes require
restarting that service. Back up the environment and settings before changing
them, preserve unrelated settings and keys, and keep credential-bearing files
readable only by their owners.

Verify the native listener, an authenticated `GET /v1/models`, rejection without
a key, and continued access through the existing domains. A model-list check
does not establish model inference behavior. No Luna restart is required for
changes confined to this external deployment.

Environment-specific addresses, service paths, backups, and verification results
are recorded in the Git-ignored `docs/local/magpie-hosta-deployment.md`.
