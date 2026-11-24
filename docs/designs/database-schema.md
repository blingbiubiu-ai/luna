# Database schema

Service stores its business database at `$LUNA_HOME/data/luna.db`.
`src/data/schema/` contains domain-specific TypeScript ORM definitions.
`src/data/drizzle/0001_luna_baseline.sql` defines the initial SQLite baseline, with
incremental Drizzle migrations (`0002`–`0008`, including `agent_settings`,
`agent_profile_revisions.execution_driver`, `platform_auth_settings` for
AES-256-GCM encrypted platform-wide Feishu OAuth login credentials, ambient
listening state, channel-agnostic `account_identity_claims` for automatic
Agent owner recognition, `platform_settings` for Dashboard-managed platform
runtime configuration, and `sessions.parent_session_id` backfill plus index
for Main topic sessions) applied on open.
Databases created before platform accounts and per-Agent users
are refused (`database_baseline_mismatch`); a new database takes their configuration
with `luna service admin import-config` ([accounts and users](accounts-and-agent-users.md)).

## Initialization contract

The baseline creates the current tables, indexes, foreign keys, CHECK constraints
and triggers directly. It does not replay retired deployment migrations.
Drizzle's `__drizzle_migrations` is the initialization record.

`DataConnection` accepts an empty database or a database whose first Drizzle
record matches the current baseline hash and timestamp. It validates the baseline
before schema writes, enables WAL (`synchronous = NORMAL`, `journal_size_limit = 64 MiB`),
foreign keys, `busy_timeout = 5000`, a 128 MiB page cache (`cache_size = -131072`),
a 512 MiB `mmap_size` window, and in-memory temporary tables (`temp_store = MEMORY`),
and invokes the migrator.
Initialization failure closes the connection. Unknown or retired baselines fail
without automatic conversion or data deletion. The administrator CLI uses the
same check and requires an initialized database with an active human user.

## Scoped routing and configuration

`shadow_worker_routing` stores automatic or bound Worker selection. Missing
configuration defaults to automatic routing. Composite foreign keys keep the
Shadow and Worker assignment inside one Agent. CHECK constraints require no
Worker ID in automatic mode and a Worker ID in bound mode. Admission and paused
state remain in `agent_worker_access`. Routing changes do not move historical
session or task data.

`shadow_model_selections` defaults to following the Agent's active Profile.
Fixed mode references a validated revision owned by that Agent. Composite
constraints and triggers preserve ownership and prevent deletion of Profiles
still used by non-deleted Shadows. A saved selection retains its revision when
the Profile is edited.

Agent/default-Shadow references use deferred foreign-key checks so an atomic
creation transaction can insert both entities while rejecting an invalid final
ownership graph. Resource and invocation snapshot references preserve immutable
execution ownership and resource selection. Authorization stores rules rather
than a persisted catalogue of operation definitions.

## Operational boundaries

Service business state and Runtime scheduling state use separate connections and
schemas. Worker maintains its own local execution database. Do not copy a
Worker database into Service or use database reset as an upgrade procedure.
Backup and rollback must preserve compatible database, configuration, artifact
and encryption-key versions. See the [deployment guide](../runbooks/deploy-luna.md).

Schema changes must keep TypeScript definitions and SQL constraints consistent,
including deferred references, ownership checks and deletion guards. See
[Agents and Shadows](platform-agents-and-shadows.md) and
[Worker storage](worker-storage-layout.md).


Task progress shares `timeline_events`: `runner.tool` inserts on start and updates on result, while public text and state remain separate rows. Migration 0009 adds `task_run_id`, `updated_at` and Task/Run ordering indexes. See [Progress notifications](progress-notifications.md).

Migration 0010 (`0010_agent_proactivity.sql`) adds proactivity persistence: `shadow_heartbeats` (per-Shadow dedicated Heartbeat local session, activity cursor, covered window and latest command), `correlated_requests` (unified `ask` and `handoff` tracking with options, resolution payload, expiry and callback command), and `schedule_failure_notifications` (rate-limited owner DM notifications for failed schedules), alongside `task.run` schedule actions and `deferred` quiet-hours command state. See [Agent Proactivity](agent-proactivity.md).

## Process-data retention

`ProcessDataRetentionScheduler` (`src/data/process-data-retention.ts`) periodically prunes expired tool-call traces and associated progress-delivery state older than `platform_settings.settings.retention.retentionDays` (default 30 days, checked every `retention.intervalMinutes`, default 60 minutes, live-configurable on Dashboard `/platform/settings`): intermediate `runner.tool` rows in `timeline_events` on finished Tasks (preserving `runner.step`, lifecycle events, and artifact-linked rows, and recording one deterministic `timeline.tools_pruned` summary marker per affected Task Run so Dashboard timelines explicitly indicate pruned tool counts), sent/skipped status-card progress update rows (`update_status_card_progress` / `update_status_card`) in `notification_attempts` on finished Tasks (preserving `create_status_card` and `publish_task_result`), settled `native_progress_deliveries` (preserving quarantined `$.pending` rows and active/waiting Task cards), and settled status-card / `progressSnapshot` rows in `session_reply_dispatches` and `session_channel_deliveries` (leaving ordinary chat replies and active session/task cards untouched), followed by a passive WAL checkpoint. Durable `messages`, `session_timeline_entries`, `tasks`, `artifacts`, prompts, runner attempts, and `agent_memories` are never pruned.
