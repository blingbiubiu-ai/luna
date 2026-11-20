# Auth And Permissions

## Identity Sources

Luna requests can be authenticated through Dashboard user sessions, CLI tokens, MCP/service tokens, or runner tokens. The runtime should resolve each request to one of:

- a canonical user.
- a runner scope.
- an internal service authority.
- an unauthenticated signed-link holder.

Channel identities are display and provider-debug records. They are not authorization subjects.

## Dashboard User Access

Dashboard uses authenticated account/session access (`luna_dashboard_session`). Sign-in resolves to a platform `accounts` record (`local-dashboard-user` for local access-token login or `feishu:<union_id|open_id>` for Feishu OAuth login), and Agent-scoped requests then map that account to its per-Agent `users` record for group membership, operation grants, and resource-specific policies.

Dashboard should not read local databases or files directly. It must use Luna Service APIs so authorization, audit, and artifact signing remain centralized.

### Feishu OAuth Sign-In

Feishu OAuth sign-in replaces the legacy `/api/auth/sso/*` placeholders with:

- `GET /api/auth/feishu/start?next=...`: issues a 10-minute HMAC-signed OAuth state (`feishu-oauth-state`) carrying a sanitized relative `next` path and CSRF `nonce`, writes `luna_feishu_oauth_state` (`HttpOnly`, `Path=/api/auth/feishu`, `SameSite=None; Secure` over HTTPS and `SameSite=Lax` over HTTP), and redirects to `${feishuHost}/open-apis/authen/v1/authorize` without requesting sensitive scopes.
- `GET /api/auth/feishu/callback`: validates the signed state (requiring matching `luna_feishu_oauth_state` when the cookie is present, while remaining compatible with Feishu webview cross-site hops), exchanges `code` via Feishu v1 OIDC (`app_access_token/internal` → `authen/v1/oidc/access_token` → `authen/v1/user_info`), ensures an active `accounts` record (`feishu:<union_id>` with `open_id` fallback, keeping `display_name` and `avatar_url` current), sets `luna_dashboard_session`, and redirects to `next`.

Feishu OAuth credentials are resolved from `platform_auth_settings` (`provider = 'feishu'`, managed by platform administrators via `/api/platform-settings/feishu-auth` with AES-256-GCM secret encryption and live `app_access_token` verification on save), falling back to environment variables (`LUNA_FEISHU_APP_ID` / `FEISHU_APP_ID`, `LUNA_FEISHU_APP_SECRET` / `FEISHU_APP_SECRET`, `LUNA_FEISHU_HOST` / `FEISHU_HOST`, and `LUNA_FEISHU_PUBLIC_BASE_URL` / `LUNA_SERVICE_URL` / `PUBLIC_BASE_URL`) or `config.yaml` (`auth.feishu.*`). API responses never expose `appSecret`.

## Listener startup safety

The public development Dashboard token is allowed only on literal loopback
listeners (`127.0.0.1` and `::1`). CLI option resolution, runtime option
resolution and HTTP server startup reject non-loopback binding when
`LUNA_DASHBOARD_TOKEN` is missing, blank or equal to the development default.
Explicitly setting the default does not bypass the guard. DNS hostnames are not
assumed to resolve to loopback. A loopback listener exposed by a reverse proxy
still requires an operator-configured unique token and HTTPS; the listener guard
cannot detect proxy exposure.

## Service Bearer Token

Service bearer token is a service operation. It should not be documented or treated as a blanket user-facing resource-access model.

Internal service callers may perform service-owned operations, but user-visible resource access should still be explainable through related user, operation grants, runner scope, or signed links.

## Runner Token

Runner tokens are scoped runtime credentials:

- Main Runner token is scoped to its session.
- Task Runner token is scoped to its task.
- Runner tokens cannot spoof arbitrary session/task ownership.
- Runner artifact access is restricted to the current runner context and its artifact allowlist.

Runner tokens should be enough for runner operations such as `luna artifacts register` and `luna artifacts materialize`, but they should not become unrestricted artifact readers.

## Operations and authorization rules

An operation is a stable dotted action identifier, such as
`workspace.knowledge.read` or `examplecli.settings.config.get`. There is no persisted
operation definition/policy catalogue and no standalone capability management
page. Builtin operation metadata lives in code; plugin operations and dynamic
namespace ownership live in the loaded plugin registry. Input/output schemas
belong to execution contracts, never authorization rules.

`authorization_rules` stores only `id`, `subject_type`, `subject_id`,
`match_type` (`exact` or `prefix`), `target`, `effect`, `expires_at`, and
timestamps. A prefix target `examplecli.settings` is displayed as `examplecli.settings.*`.
It matches the prefix itself and dot-delimited descendants, not `examplecli.settings2`.
Bare/interior wildcards are rejected. No rule expansion or foreign key to an
operation catalogue is needed. Plugin disable/removal and restart preserve rules.

Creation validates the owning namespace and subject type. Dynamic namespaces
accept future operation paths without per-action registration. Static plugin and
builtin exact targets must be known; prefixes must cover a known operation.
`system.admin` remains user-only. Knowledge HTTP/MCP actions keep their builtin
checks even though they are not plugins.

For a canonical user, collect direct rules and active-group rules within the authorized scope; ignore expired
rules and rules incompatible with the operation's subject types. Any matching
deny wins, then any matching allow, then the operation's plugin/builtin default.
Request parameters, row limits, resource identifiers, and schemas never affect
this evaluation. Resource-specific ownership and runner boundaries remain
separate checks. API writes reject legacy parameter-constraint fields.

Dashboard Users and Groups pages edit rules through a shared dialog: choose a
scope, enter/select an operation path, choose exact/prefix, allow/deny, and optional
expiry. The dialog previews the resulting target. Both pages are Agent-scoped and
managed by the Agent owner: `GET /api/operations?agentId=` supplies the grantable
Agent operations (no `system.*`, no audits), and rules are written as Agent rules
through `/api/users/:id/authorization-rules[/batch|/:grantId]?agentId=` (only users in
that Agent's directory) and `/api/groups/:id/authorization-rules[/batch|/:grantId]`.
The platform `/api/authorization-rules` endpoints remain for `system.admin` only.

Plugin invocation audits record `operation_id`, execution result, and
`authorization_json` containing the decision, reason, matched rule IDs and rule
snapshots. Rules remain understandable after subsequent edits/deletion.

## Database baseline

Fresh databases create scoped `authorization_rules` directly. Capability-era
storage and data conversion are not supported. The single SQL baseline retains
all authorization constraints and triggers; startup validates its Drizzle hash
before reopening a database. See [database schema](database-schema.md).
Capability-era plugin manifests are rejected at registration; packages must use
the operations contract.

## Artifact Access Policy

Artifact access combines general identity with resource-specific checks:

- Authenticated human reads require ownership of the Agent. MCP callers use the same user policy.
- Runner reads additionally require the artifact to remain in the calling Shadow and match the claimed resource or invocation artifact allowlist; an owner or related-user identity does not widen Runner access.
- Main and Work register artifacts in their session. Task registers artifacts in its task. Main processing a task result reads task artifacts through the invocation allowlist.
- A valid signed URL permits content/preview sharing until expiry. Authenticated non-Runner readers may create signed URLs.
- Deletion requires readable access and either the Agent owner or the explicit related user. Runners cannot delete or create sharing URLs.

This model keeps short-lived sharing simple while still allowing related users to recover access after a link expires.

## Signed Link

Signed artifact links are generated by Service and expire after 2 hours.

A valid signed link grants access until expiry to whoever holds the URL. After expiry:

- anonymous access fails.
- authenticated unrelated users are denied.
- authenticated related users can continue through normal artifact authorization.
- internal service callers can still perform service-owned operations.

The frontend must request links from Service. It must not compute signatures.

## Threat Model

| Caller | Without signed link | With valid signed link |
| --- | --- | --- |
| External unauthenticated user | Denied | Can read signed artifact content/preview until expiry |
| Authenticated unrelated user | Denied | Can read signed artifact content/preview until expiry |
| Admitted Agent user | Can read artifacts owned by an accessible session/task | Can read signed artifact content/preview until expiry |
| Main Runner token | Can operate only within its session scope and allowlist | Can read signed artifact content/preview until expiry |
| Task Runner token | Can operate only within its task scope and allowlist | Can read signed artifact content/preview until expiry |
| MCP user token | Same Agent and resource checks as its human actor | Can read signed artifact content/preview until expiry |

## Primary Code Paths

- `src/server/auth.ts`
- `src/server/auth/feishu-oauth.ts`
- `src/server/auth/access-token-service.ts`
- `src/server/routes/auth.ts`
- `src/server/routes/platform-settings.ts`
- `src/server/auth/token-scope.ts`
- `src/server/artifact-access-policy.ts`
- `src/server/routes/artifacts.ts`
- `src/permissions/permission-engine.ts`
- `src/server/policy/authorization-rule-store.ts`
- `src/server/policy/authorization-subject.ts`

## Session commands and trigger runtime

The current shared dispatcher, durable trigger ledger, asynchronous message
commands, handoffs and schedules are documented in
[Session command runtime](session-command-runtime.md). Runner side effects remain
Service-owned; the runner submits commands and does not call provider SDKs.

### Session command authentication

Session commands no longer use per-target `authority-id` grants. A live,
authenticated Main invocation may submit cross-session sends, handoffs, schedules
and group operations. The service validates the active actor, target and artifact
availability at acceptance and execution. Dashboard administrative endpoints still
require admin authentication; provider permissions remain enforced externally.
Session commands and schedules persist the actor and session scope used for these checks.

## Worker bindings

Worker protocol endpoints `/api/worker/*` have their own authentication before Dashboard middleware. Binding requires an unexpired one-time 256-bit code; Service consumes it transactionally and stores only the hash of the issued Worker token. The private Worker configuration stores the token. Each WebSocket is bound to that authenticated Worker; replacement connections invalidate old pending calls. Event ingestion checks Job/Worker/Executor assignment identity. Downloads require a valid binding. Pausing or resuming an assigned Worker requires Agent ownership and either ownership of the local Worker or a valid platform `system.admin` grant. Dashboard pause and resume apply to the selected Agent–Worker assignment. Runtime operator controls can drain the entire Worker for maintenance. Local automatic enrollment uses the existing private Runtime admin credential and Worker configuration; it is not an unauthenticated localhost registration endpoint.

## Agent authorization foundation

Authorization rules now carry an explicit platform or Agent scope. The rule store filters reads, writes, deletion and effective-grant collection by that scope; omitting it fails with `authorization_scope_required`. Platform rule creation only accepts `system.admin`. Agent rule creation rejects platform operations. Agent grants govern operations for active users, including tool calls triggered by Feishu messages. Dashboard visibility requires Agent ownership.

Groups have a required Agent owner and a unique `(agent_id, slug)` key. Granting a foreign Agent's group is rejected. Group membership creation checks the user and the group’s Agent are active, and non-administrator Agent owners may only add users already visible in that Agent's directory. Dashboard permission-group reads and mutations require the Agent owner; platform administration is not involved except when bootstrapping a non-directory platform user. Agent self-service rule routes derive scope from their authorized Agent path.

`requireAdmin` now checks an active human canonical user and evaluates `system.admin` with normal expiry and deny precedence. A Dashboard cookie alone is insufficient. The authenticated middleware supplies the policy database through server-side request context; missing context fails closed. Agent ownership does not imply platform administration.

Plugin dispatch now requires Agent/Shadow scope, Agent enablement and scoped operation grants; unaudited manifests cannot enable Agent execution. Its runtime wrappers revalidate scope/configuration/grants before side effects. Knowledge HTTP/MCP now share a boundary that requires Agent ownership for human requests and scoped business grants for Runners and use independent Agent Git roots. Runner knowledge calls derive scope from an active persisted invocation and require business grants even when the human actor owns the Agent; they never inherit owner management access. Human requests must explicitly select agentId. The `luna knowledge`, `luna workspace knowledge`, and `luna service mcp bridge --stdio` commands accept `--agent-id <id>` or `LUNA_AGENT_ID`. HTTP MCP uses `/mcp?agentId=<id>`. Runner tokens derive the Agent from their active invocation and reject a conflicting Agent selection. The local Service uses the platform schema and a fresh database. The previous local database is archived.


## Scoped session, task and artifact HTTP access

`ResourceRouteAccess` guards session and task routes. Human access requires Agent ownership. Lists require `agentId` and optionally validate `shadowId`. Runner requests remain limited to the resource claimed by their invocation. DELETE also requires Dashboard authentication.

Runner access to these HTTP resources is additionally constrained to the exact claimed session/task. A Runner carrying an owner's user ID does not receive owner-wide lists. Actual authentication middleware still verifies active invocation authority before routing. Runner tokens carry Agent and Shadow claims and are checked against the persisted invocation.

Artifact policy now receives the database and resolves the artifact's actual session/task owner. Authenticated human access requires ownership of the artifact’s Agent. MCP tokens have no global internal-service exemption. Runner own-resource and allowlist reads stay inside the Runner's Shadow. Runner registration, metadata, and preview responses use authenticated content URLs. Preview resolves nested signed links only within the source artifact’s Shadow. Preview opened without a signed URL also checks the viewer’s access to each referenced artifact. Dashboard signing no longer grants every logged-in user a URL for any artifact. Registration routes authorize the requested session/task before writing. Valid explicit signed content/preview URLs retain their existing expiry/sharing semantics.

Artifacts retain polymorphic owner fields and also persist Agent and Shadow IDs. Managed storage is partitioned by Agent and Shadow. Deletion and surviving-reference handling use the artifact's persisted scope. Dashboard and CLI resource requests supply Agent scope or derive it from the authenticated invocation.

## Agent Worker authorization

`agent_worker_access` stores active/disabled state, admission pause and change
metadata per `(agent_id, worker_id)`. Runtime owns Worker registration identity.
Local and global Workers have no implicit Agent admission. New execution uses
active, unpaused assignments. Pausing preserves the assignment, placement and
file/resource access needed by accepted Jobs.

Agent owners issue single-use binding codes. Runtime records the issuer and
Agent, rechecks ownership and active state at redemption, and assigns only that
Agent. Rebinding verifies the existing Worker credential and owner. The
configured local `homeWorkerId` has protected assignment semantics. Initial
local registration uses Runtime management credentials once; Agent assignment
then uses Worker credentials and the Agent's binding code.

`/api/agents/:agentId/workers` exposes owner-scoped lists, codes, pause/resume and
unassignment. Revoking access alone does not cancel Jobs or release placement;
the execution settlement and draining flows retain that responsibility.

## Platform administration and Dashboard scope

The built-in access-token operator account (`local-dashboard-user`, authenticated with `LUNA_DASHBOARD_TOKEN`) is the platform's unrevokable **Super Administrator** (`isSuperAdministrator`): it always satisfies `isPlatformAdministrator` / `requireAdmin` and cannot be disabled, deleted, or stripped of administrator authority.

Feishu OAuth accounts (`feishu:<union_id|open_id>`) start with no platform privileges (they only own and manage the Agents they create). Platform administrators and the Super Administrator manage accounts and grant or revoke platform-scoped `system.admin` on `/platform/accounts` (`GET /api/accounts`, `PUT /api/accounts/:id/admin`, `PUT /api/accounts/:id/status`, `DELETE /api/accounts/:id`), entered from `/platform/settings`. Host operators can also grant `system.admin` via `luna service admin grant --home <service-home> --account-id <account-id>`. Agent grants and Runner identity never confer platform administrator status, and administrators cannot revoke or disable their own currently signed-in account.

Session, task, overview, user and group queries require explicit Agent scope and
ownership. Shadow-specific lists also include Shadow scope in their cache keys.
Detail endpoints independently authorize the fixed resource ID. Platform admins
follow the same private ownership boundary. Users, groups, memberships and their
grants belong to the Agent and are managed by its owner, as are the Agent's Worker
admission pause and channel status. Personal CLI/MCP tokens (`/api/auth/tokens`)
are managed by each signed-in user for themselves. Deleting a user account
(a platform-wide record) and platform permission changes require administrator
authority.
