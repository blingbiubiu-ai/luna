# Progress notifications

Task and Work dispatch each tool start, tool result and complete public Assistant
text observation immediately through `LiveProgress`. There is no timer, tool-count
aggregation or batching window. Thinking, full arguments and raw tool output are
excluded from this public progress path. Prompts and LLM narration are unchanged.

## Durable Task timeline

`timeline_events` is the single Task progress store. A `runner.tool` row is
inserted when a tool starts and updated when its result arrives. Its deterministic
identity includes Job ID, provider retry attempt and original tool call ID.
Metadata contains bounded title/name, run/job IDs, source sequence, status,
startedAt and finishedAt. Status is running, ended, failed or interrupted. The
creation timestamp remains fixed when the result updates the row. An interrupted
tool has an unknown outcome; interruption does not invent a completion time.
An old live call whose start predates the upgrade gets an explicit unknown-start
row on result. Existing lost tool history cannot be backfilled from this table.

Public text is a separate `runner.step` row: summary is bounded for cards, while
`data.text` preserves the public body. Lifecycle state, results and reports keep
existing event types. There is no separate tool table, tool summary row or JSONL
progress journal. Original Runner logs are independent of this business timeline.

Runtime event consumption, progress projection and Job cursor commit in one
Service DB transaction. Duplicate source sequences are ignored. Failed projection
rolls back both row and cursor. Retry attempts have separate call identities;
retry, revoke and terminal events interrupt unresolved tools. Reconnecting an
active remote Job preserves its running tools. Late revoked events cannot change
Task progress. Migration 0009 adds nullable `task_run_id`, `updated_at`, backfills
old metadata/timestamps and indexes Task/Run creation and update order.

## Incremental presentation protocol

`ProgressUpdate` contains streamKey (Task Run or Work Turn), mode (delta or
snapshot), position and typed entries with stable IDs and update timestamps.
Normal callbacks pass the current observation only. Initialization, recovery,
terminal recovery and explicit resend request a bounded snapshot (at most 200
recent progress entries). Upper Task/Work layers do not maintain card histories.

The serial sender preserves observation order; preceding tools are sent before
following public text. Network waits do not block provider consumption. At most
600 observations wait in the queue and 300 active tool identities are retained.
Backpressure may drop old presentation updates, but Task durable progress remains
queryable. Closing drains accepted updates before terminal delivery. Work keeps
its existing message/body persistence and stores the rendered card projection;
it does not create Task timeline rows.

Ordinary Card owns a per-message projection inside the Feishu adapter. It upserts
by entry ID, preserves creation order, rejects stale updates/status regressions,
and clips locally to `platform.messaging.maxVisibleSteps` (1–200, default 32).
It sends the full resulting card to Feishu on each observation. It restores this
window from existing delivery receipts or persisted card messages after adapter
restart. Each receipt carries `progressSnapshot`. Terminal guards prevent later
active updates from reviving a completed card. No history DB scan occurs on the
ordinary hot path; the adapter lazily loads one saved projection on cache miss.

Native translates the same envelope to individual text/start/result protocol
events and owns append/update/deduplication. Tool results update their original
node. Requests stay within 8 KiB. Display budget remains 300 ordinary nodes
(including title) and 252 KiB, with six nodes / 4 KiB reserved for a limit notice
and terminal delivery (256 KiB total). Existing displayed tool results may update
after the node limit within the byte budget. The notice directs users to the
Dashboard's complete history. Final answers remain independent of display limits.
These are Luna budgets, not a guarantee of Feishu client display capacity.

`native_progress_deliveries` keeps pending requests, acknowledged IDs, open tools
and budget state. Pending is saved before sending and acknowledgement on confirmed
success. Unknown network outcomes remain quarantined across restart; they are not
cleared to force resend. Explicit resend creates a new message. Work Native create
keys stay fixed per Turn; update keys include the observation fingerprint.

## Queries and Dashboard

`GET /api/tasks/:id/progress` and `luna task progress --task-id …` expose compact
state, latest public text, last activity, running tools and a bounded history page.
Default page size is 20, maximum 100. Current Run is the default; runId selects a
Run or `all`. Cursor pagination orders by creation time and ID, binds Task/Run and
view scope, and uses SQL LIMIT. Task access policy applies before these reads.
Runner `task get` returns compact Task metadata plus progress instead of embedding
the entire Dashboard detail projection.

`GET /api/tasks/:id/timeline/page` serves the Dashboard 50 events at a time (maximum
100). The Dashboard polls loaded pages and loads older history on demand. A tool
stays one row while its status changes; public text is inspectable in full. Card
limits do not truncate durable history. Legacy `/timeline` is bounded to the last
100 events, and embedded Task detail timelines are also bounded per Task. Settled
`runner.tool` events and associated progress-card delivery rows (`notification_attempts`
progress updates, non-quarantined `native_progress_deliveries`, and status-card
`session_reply_dispatches` / `session_channel_deliveries`) on finished Tasks/Turns
age out after `platform_settings.settings.retention.retentionDays` (default 30 days;
see [Database schema](database-schema.md#process-data-retention)), replacing deleted
`runner.tool` rows with one per-Run `timeline.tools_pruned` count marker surfaced in
Dashboard Task timelines while `runner.step` public text, lifecycle milestones, and
artifact-linked events remain permanently.

## Code paths

- `src/timeline/task-progress-store.ts`
- `src/runners/invocation-store.ts`
- `src/messaging/notifications/progress-update.ts`
- `src/messaging/notifications/live-progress.ts`
- `src/kernel/task-run-handler.ts`
- `src/tasks/task-run-notification-service.ts`
- `extensions/channels/feishu/messaging/ordinary-progress.ts`
- `extensions/channels/feishu/messaging/native-task-progress.ts`
