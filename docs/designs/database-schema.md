# Database schema

Service stores its business database at `$LUNA_HOME/data/luna.db`.
`src/data/schema/` contains domain-specific TypeScript ORM definitions.
`src/data/drizzle/0001_luna_baseline.sql` defines the initial SQLite baseline, with
incremental Drizzle migrations (`0002`–`0004`, including `agent_settings`,
`agent_profile_revisions.execution_driver`, and `platform_auth_settings` for
AES-256-GCM encrypted platform-wide Feishu OAuth login credentials) applied on open.
Databases created before platform accounts and per-Agent users
are refused (`database_baseline_mismatch`); a new database takes their configuration
with `luna service admin import-config` ([accounts and users](accounts-and-agent-users.md)).

## Initialization contract

The baseline creates the current tables, indexes, foreign keys, CHECK constraints
and triggers directly. It does not replay retired deployment migrations.
Drizzle's `__drizzle_migrations` is the initialization record.

`DataConnection` accepts an empty database or a database whose first Drizzle
record matches the current baseline hash and timestamp. It validates the baseline
before schema writes, enables WAL and foreign keys, and invokes the migrator.
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
