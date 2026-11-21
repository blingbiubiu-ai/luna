# Progress notifications

Task and Work use `LiveProgress` to dispatch each tool start, tool result and
complete public Assistant text event immediately. There is no timer, tool-count
aggregation or batching window. Thinking, full arguments and raw tool outputs
remain excluded. Progress handling does not change prompts or generate extra
LLM narration.

## Memory, persistence and ordering

Tools produce transient steps for the ordinary card's in-memory projection and
individual Native entries with stable call IDs, bounded titles and category
icons. Tool results replace their existing in-memory step. They do not produce
Task timeline rows or tool-count summaries. Task persists only public text as
`runner.step`; existing lifecycle events, reports and results remain durable.
Work keeps recent progress in memory and persists its status-card snapshot
through the existing path.

Each observation enters a single serial sender immediately. One observation is
passed per send; slow network requests do not block provider consumption, but
following observations wait in order. At most 600 observations wait in the
queue, with older noncritical progress dropped under backpressure. The sender
keeps at most 300 active tool identities and card projections retain at most
200 recent steps. Closing rejects new observations and drains accepted updates
before terminal delivery.

Existing session delivery payloads, attempts, receipts and Native checkpoints
still persist for delivery recovery. These can contain the public tool delivery
payload; they are not a new tool journal or individual business timeline rows.
Hard termination can lose queued noncritical progress; there is no added tool
recovery log.

On Service reconnect, Runtime transport restores saved provider text without
emitting it as new progress. Only events after the persisted cursor and confirmed
terminal output are emitted. Existing Native messages retain their displayed
nodes. Recovery, terminal updates and explicit resend query at most the current
run's 200 recent timeline rows, now containing public text and lifecycle events.
Historical individual tools are not reconstructed from business history.
Legacy JSON-string metadata and `nativeText` fields remain compatible.

## Ordinary Card and Native

Ordinary Card replaces its message with the current complete card. It renders
the tail of the in-memory projection according to
`platform.messaging.maxVisibleSteps`, range 1–200 and default 32. Normal hot
updates do not reread timeline history. Tools and their updated results can
appear while running; a recovered or terminal projection reflects persisted
public text and lifecycle state rather than a permanent tool trace.

Native appends each observation to one provider message. A tool result updates
its existing tool node rather than adding another statistics paragraph. Each
request contains protocol events for that observation and stays within 8 KiB;
there is no deliberate wait to gather multiple observations.

Ordinary display budget is 300 nodes (including the title) and 252 KiB. Six
additional nodes / 4 KiB reserve room for one limit notice and terminal delivery,
for a total 256 KiB budget. Results for already displayed tools may update after
the node limit within the ordinary byte budget. Exhausted checkpoints remain
exhausted until explicit resend starts a new message. These are Luna budgets,
not a verified Feishu client capacity guarantee. Final answers remain independent
of these display budgets.

`native_progress_deliveries` JSON tracks the optional `progressBudget`, pending
request state, acknowledged IDs and open tools. Pending is saved before sending;
acknowledgement is saved on confirmation. Unknown outcomes remain quarantined
across restart; known rejection clears pending. IDs are not pruned. Legacy byte
accounting starts with newly sent events. Work's Native create key stays fixed
per Turn. There is no new table, column or migration.
Work Native update request keys also include the event payload fingerprint, so
a result is delivered even when its ordinary card step text matches its start.

## Code paths

- `src/messaging/notifications/live-progress.ts`
- `src/kernel/task-run-handler.ts`
- `src/tasks/task-run-supervisor.ts`
- `src/tasks/task-run-notification-service.ts`
- `src/work/work-runner.ts`
- `src/runners/session-agent-invocation.ts`
- `extensions/channels/feishu/messaging/native-task-progress.ts`
