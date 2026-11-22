# Unified Task progress and card adapters

Approved implementation: use the existing `timeline_events` table for all Task
progress. No separate tool table. Each tool inserts one lightweight `runner.tool`
row at start and updates it at result; public body remains a `runner.step` row.
Persist public body, bounded title/name, call identity, Run/Job/attempt/source
sequence and outcome timestamps. Exclude full arguments, raw outputs and thinking.

Task and Work send typed delta envelopes. Initialization/recovery/resend use an
explicit bounded snapshot. Native owns append/node updates; ordinary Card owns
its window, upserts and clips it, then sends its full rendering. Save the ordinary
window through existing receipt/card storage for restart recovery.

Main queries compact current progress and paginated history. Dashboard pages the
single timeline, shows tool status/start/end and full public text. No progress
aggregation, timer or extra narration. Native budgets remain unchanged.

Verification covers event transaction rollback/deduplication, one row per tool,
retry/revoke, pagination scopes, adapter clipping/recovery/stale updates, Native
identity/budgets, service routes, and the real local Dashboard on port 8090.
Current architecture is documented in `docs/designs/progress-notifications.md`.
Remote deployment waits for restored HostA authentication and preserves active
remote Jobs during Service restart.
