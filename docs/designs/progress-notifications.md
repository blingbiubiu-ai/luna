# Progress notifications

Task and Work use `BufferedProgress` to aggregate public execution progress in
Service memory. Ordinary tool starts/results update bounded counters; they do
not create individual Task timeline rows. There is no new tool journal. Existing
Runner/provider logs and Executor state ownership remain unchanged.

Tool-only windows flush every five seconds. A complete public Assistant text
event flushes immediately, with the preceding tool summary before the text.
Thinking and tool arguments are excluded. Counts describe observations in that
window; results can arrive in a later window than their starts. A tool failure
does not imply Task failure.

Task persists one summary row per flush and passes new rows directly to its
notification lifecycle. Hot updates do not reread the full task timeline. Each
run's card projection retains at most 200 recent summaries. Recovery, terminal
updates and explicit resend query at most the current run's recent 200 rows,
including legacy JSON-string run metadata. Work keeps the same bounded projection
and persists its status message through the existing path.

The buffer permits one send in flight and retains at most 200 pending summaries.
Batches retain order; under backpressure the oldest noncritical pending summaries
can be omitted. Producer callbacks do not await ongoing notification requests.
Initial status-message creation may await its receipt once. Closing stops the
timer, persists the last window and discards pending active sends; terminal
notification follows the existing serialization path. Hard process termination
can lose recent noncritical progress.

On Service reconnect, Runtime transport restores saved provider text into its
internal output bookkeeping without emitting it as fresh Assistant progress.
Only events after the persisted Job cursor and confirmed terminal output are
emitted. This avoids duplicate timeline rows and notifications from snapshot
replay; fresh events may still contain the same text as earlier events.

## Card and Native

Ordinary Card still replaces the current message. Its existing
`platform.messaging.maxVisibleSteps` setting controls the rendered tail, with
range 1–200 and default 32. The internal ceiling supports that maximum and is not
a new fixed display setting.

Native appends events to one provider message, batching requests up to 8 KiB of
serialized request data. A checkpoint tracks cumulative serialized event bytes
and ordinary entry count. Ordinary progress uses at most 94 entries and 28 KiB;
a further six nodes / 4 KiB are reserved for the one-time budget notice and
terminal delivery. Total event budget is 32 KiB. These are Luna limits, not a
verified Feishu client capacity guarantee. Task and Work final answers remain
independent of these display budgets.

Existing `native_progress_deliveries` JSON gains optional `progressBudget`
metadata; no new table or migration is required. A batch marks pending before
the request and saves acknowledged IDs/state after confirmation. Unknown outcomes
remain quarantined across restart. Known rejection clears pending as before.
Acknowledged IDs are not pruned. Legacy rows count old IDs but cannot reconstruct
old message byte size; byte accounting starts with new events.

Work uses a stable Native create key per Turn. An ambiguous create cannot be
bypassed by changing the following progress text.

## Code paths

- `src/messaging/notifications/buffered-progress.ts`
- `src/kernel/task-run-handler.ts`
- `src/tasks/task-run-supervisor.ts`
- `src/tasks/task-run-notification-service.ts`
- `src/work/work-runner.ts`
- `src/runners/session-agent-invocation.ts`
- `extensions/channels/feishu/messaging/native-task-progress.ts`
