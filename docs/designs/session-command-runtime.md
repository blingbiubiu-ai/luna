# Session triggers, commands and delivery

See [Sessions and Main Runner](sessions-main-runner.md) and
[Tasks and Task Runner](tasks-task-runner.md) for the surrounding execution model.

## Execution and persistence

User messages, task results and session-trigger commands share the per-session
`SessionDispatcher`. Different sessions execute concurrently; each session runs
one Main invocation at a time. Dispatch is single-process, matching the existing
Luna service topology; running multiple services against one database is not
supported.

`session_triggers` is the common durable trigger ledger. The existing user inbox
retains its batching payload and claim/turn semantics. SQLite insert/update
triggers synchronize its lifecycle into the ledger atomically. Task-result
publications store their payload directly in the ledger. `session.invoke`
commands similarly project their lifecycle into the ledger. Recovery belongs to
each source adapter: user batching recovery, task notification recovery and
pending command recovery all re-enter the same dispatcher. This avoids encoding
all source payloads in the user-message table.

Session-trigger instructions use a distinct MainRunnerInput variant. Acceptance
freezes explicit artifact references and the instruction in a context pack.
Execution selects recent target-session messages into a separate delta pack;
undelivered messages and internal trigger anchors are excluded. The invocation
and turn are recorded. Structured task actions continue through the existing
Task Engine/Supervisor path, with an internal source anchor, not a fabricated
external user message. Task dispatch requires an existing external conversation
message anchor; a newly created empty local session can receive direct messages
and trigger replies, but cannot yet start anchored task actions. Reply actions
produce message commands.

## Commands and delivery

`session_commands` is the durable command/outbox record. Acceptance atomically
writes the idempotent command and, for messages, the target message/timeline fact.
No provider call runs inside that transaction. New requests return HTTP 202 with
pending status. No model invocation is needed to deliver a message.

A worker conditionally claims pending commands with a unique claim token.
Terminal writes check that token. Sends use `DeliveryTarget` and the channel's
`sendTo` port; the Feishu implementation creates a message in the target chat,
or replies to an existing thread root. Compatibility-only adapters can use the
older inbound-shaped send port. Provider IDs are stored on the delivery record;
Luna message identity remains stable across delivery.

Lifecycle: pending → running → sent (message) / completed (invocation).
Authorization/validation failures become failed; expiry becomes skipped;
cancellation becomes cancelled. Provider acceptance with a lost response becomes
unknown. Restart also marks in-flight commands unknown rather than blindly
repeating tools or sends. Pending work survives restart. Missing channels are
retried with bounded backoff. The admin retry endpoint requires explicit
acknowledgement of duplicate risk for failed/unknown commands.

Workers track execution separately from their periodic scan, so a long-running
Main does not block progress-message delivery or another session's work.
Cancellation stops new runner commands immediately; already accepted messages
remain independently deliverable. Queue cancellation does not retract delivered
messages. Task and Work status cards have their own operational notification
records, independent of Runner message commands.

## Authentication and targets

Runner APIs require a verified Main token plus an active process-local invocation.
Completion, abort and restart invalidate that capability. Actor and source IDs
come from the invocation, never request JSON. Cross-session messages, handoffs,
schedules and group operations do not require an `authority-id`. Acceptance and
execution check active actors, active target sessions and artifact availability.

Targets can name the current session, a session ID, a known surface, or a canonical
user with a uniquely known private conversation. The authenticated runner endpoint can
resolve/create a local session for a known surface using SessionStore. Unknown
session IDs fail. Explicit `feishu_user` targets carry channelId, idType
(open_id/user_id/union_id) and id. The message endpoint resolves an address into
a durable `direct_recipients` record and a provisional local session; it does not
send a message. A message command sends to the user ID if no provider conversation
is bound yet. The Feishu receipt's chat_id binds the same session and records a
p2p surface. Later sends use chat_id. Inbound private messages can complete this
binding before the HTTP receipt arrives, using the sender's matching provider ID.
Conflicting conversation bindings fail explicitly rather than silently merging
unrelated sessions. No provider calls occur inside database transactions.

An explicit provider rejection becomes failed; transport errors or incomplete
receipts become unknown and are not automatically resent. Provisional recipient
records and pending commands survive restart. Already observed private sessions
are reused where the directory can resolve them. Ambiguous users and unimported
threads fail explicitly. Group creation is an explicit command (see
below), never an implicit side effect of sending. External threads are not created. Thread delivery requires a valid root message.

Handoff does not post its instruction to the channel. It creates session.invoke,
with a correlation ID and decreasing hop budget. Self-handoff is rejected. Target
Main decides what to do; completion is not automatically sent back to the source.
For a newly provisioned topic, source Main hands off the full request without
sending its opening or creating its Task. Topic Main sends the opening through
CLI before creating the Task locally. This reuses session.invoke and message.send;
there is no new protocol, automatic forwarding loop, or extra task creator.
Commands issued by the receiving Main use its current session as sourceSessionId,
including the opening answer. The incoming handoff retains the previous source;
correlation ID and remaining hop budget propagate without attributing the
receiving Main's commands to that previous session.

## Schedules

`session_schedules` stores the actor, target, timezone, action, revision,
next occurrence and optional elapsed-time interval. Supported timing is an
absolute instant (ISO timestamp with offset in CLI), fixed intervals and calendar
rules (daily, weekdays, weekly or custom hourly/daily/weekly/monthly/yearly cycles). Calendar rules
persist local HH:mm, weekdays and an IANA timezone separately from the next
absolute occurrence. Cron expressions are not interpreted. Missing DST wall times
are skipped; repeated wall times use the first occurrence only.

Each occurrence snapshots the schedule revision and action. Occurrence creation,
command acceptance and advancing the schedule happen in one transaction. Stable
occurrence identity prevents duplicate execution after scheduler restarts.

Fixed reminders use message.send. Analysis uses session.invoke. The default
missed-time policy coalesces to the latest occurrence and records skipped ranges;
skip policy discards missed work. Overlap can skip or queue; pending occurrences
expire. One-shot schedules disable after acceptance. Edits affect future
occurrences; disabling cancels pending occurrences but does not implicitly abort
an already running turn.

An active Main or Work may create current-session or cross-session schedules without an
extra grant. The worker rechecks actor and target availability at execution.
Administrative endpoints manage schedules, occurrences and command retries.

## Interfaces

Runner endpoints:

- GET /api/runner/users — local recipient search (q, channelId, limit, offset).
- GET /api/runner/users/:id — canonical user details in the visible directory.
- GET /api/runner/users/lookup — exact Feishu lookup (channelId, idType, id).
- POST /api/runner/messages — target, text blocks, purpose.
- GET /api/runner/commands/:id — command status within the actor/source scope.
- POST /api/runner/handoffs — target, instruction, artifact IDs.
- POST /api/runner/schedules — target, optional nextAt, intervalMs or recurrence, timezone, action.

Mutating runner endpoints require Idempotency-Key. Same-key different content or
target is a conflict. Accepted answer commands suppress duplicate final reply text for new Main actions.
Task results wake Main, which sends through the same command API. The publisher
tracks that delivery instead of sending the result again.

Dashboard-admin endpoints under /api/session-commands:

- GET /commands and /commands/:id; POST /commands/:id/cancel or /retry.
- GET/POST /schedules; PUT/DELETE /schedules/:id; GET /occurrences.

CLI: `luna messages send`, `luna messages status`, `luna messages handoff`, and
`luna schedules create`. No automatic message-to-trigger conversion is performed.

## Dashboard

`/agent/schedules` uses a task list on the left and a persistent detail/editor pane
on the right (stacked on narrow screens). Schedules have a persisted title and an
explicit paused flag. Legacy titles are backfilled from instruction text. The list
groups active, paused and finished schedules, with search and natural-language
next-run times. Details include content, target session, timing and execution history;
identifiers and snapshots are collapsed. Reads refresh every 10 seconds.

Dashboard schedule lists and occurrences require the selected Agent and can be
filtered by Shadow. The Service checks Agent ownership and derives each schedule's
scope from its persisted source session. The editor accepts a target session
from the selected scope and records the signed-in owner as execution user for
new schedules. Existing source attribution is preserved. Owners can pause or
delete schedules in their Agent. Editing or resuming also requires that the
signed-in user is the persisted execution user. Runner CLI scheduling continues
to use the active invocation's authenticated scope.

The timing form has Repeat and Run time rows. Never means one-shot; interval
uses a first instant plus elapsed minutes. Calendar rules select a time and optional
weekdays, with the task timezone in Advanced settings. The server computes the
next occurrence rather than trusting a client-supplied nextAt for calendar rules.

POST /schedules/:id/state pauses/resumes using an expected revision. Editing and state
changes reject stale revisions. Edits preserve inactive state and cancel pending old
occurrences; already running occurrences retain their original snapshots.
Resume rechecks actor and target availability, moves elapsed repeat schedules to
the next future slot and never replays missed slots. Finished or elapsed one-shot
schedules must be edited to a future time before resuming.

Titles and paused state are separate from occurrence results: an accepted one-shot
is finished as a schedule even while its occurrence is still running. History retains
the actual status, reason, revision and immutable snapshot. Existing CLI/API creation
remains compatible; schedules without a title display a content-derived fallback.

Calendar dispatch coalesces missed dates to the latest eligible occurrence and
advances to the next future calendar slot. Resume also skips missed slots. Legacy
interval and one-shot schedules have a null recurrence and remain unchanged.

## Custom recurrence

Custom rules now persist frequency, every (1–100), a start date anchoring the
cycle, local start time, and the applicable weekdays/month/day. Weekly cycles
start on Monday in the task timezone. Dates before the start date/time are never
eligible. Monthly 31st and yearly February 29th skip missing dates rather than
clamping; DST rules remain unchanged. Hourly cycles are wall-clock hours (the
separate Interval option retains elapsed-time semantics). The next/previous
occurrence calculator jumps between eligible cycles, including for recovery and
pause/resume, without minute-by-minute scanning.

Existing custom weekday rules without frequency remain weekly interval-one rules.
The editor displays their equivalent weekly configuration.

Monthly and yearly custom rules accept a non-empty monthDays array (1–31), normalized to
unique sorted dates. Each valid date in each eligible month is a separate
occurrence. Missing dates are skipped individually. Legacy dayOfMonth remains a
single-date fallback; annual rules select one month and multiple dates. Annual
validation rejects dates that never occur in the selected month; February 29
remains valid and skips non-leap years. The UI uses a checkbox
dropdown that stays open for multiple selections and summarizes them in the row.
Weekly rules allow multiple weekdays. Their date selector precedes the time row
and, for custom rules, the start-date row. Custom every-N-week rules retain the
editable start date as their cycle anchor (defaulting to the creation date).

Interval editing offers a numeric value with minutes/hours units, converted to
the existing intervalMs field. No first-run input is exposed. New or changed
intervals set nextAt to save time plus one interval. Unchanged intervals retain
their next-run time; overdue schedules advance to the next future slot on the
existing cadence.

## Runner recipient directory and first contact

The runner directory is separate from the Agent-scoped Dashboard directory at
`/api/users?agentId=...`. Runner queries require an active Main or Work
invocation and active actor. They expose local identities in the current channel
or enabled configured channels with a runtime adapter. They return canonical
user IDs, display names and channel-scoped recipient IDs, never raw profiles,
contact details or administrative grants. Name search is local and paginated;
it is not a tenant-wide Feishu employee search. Repeated names return candidates.
Exact provider lookup requires channel contact permission and persists the
returned minimal identity in Luna's directory. The provider still enforces its own permissions.

CLI examples:

```sh
luna users search --query 'Alice' --channel-id FEISHU_CHANNEL
luna messages send --json --text '[{"mention":"CANONICAL_USER_ID"},{"text":" Please review this proposal"}]'
luna users get CANONICAL_USER_ID
luna users lookup --channel-id FEISHU_CHANNEL --feishu-user-id ou_xxx --id-type open_id
luna messages send --channel-id FEISHU_CHANNEL --feishu-user-id ou_xxx --id-type open_id --text 'Hello' --request-id greeting-1
luna messages send --user-id CANONICAL_USER_ID --channel-id FEISHU_CHANNEL --text 'Hello' --request-id greeting-2
```

Runner recipient resolution uses the channel of the invocation's session. An
explicit channel must match before Luna creates a local recipient or session.
User targets prefer the private root session over its threads. Multiple distinct
private conversations remain ambiguous. Group creation checks the same Feishu
binding at acceptance and again before contacting the provider. Before queued
delivery, Luna verifies that the session's binding is current and the bot is enabled.
For first contact, a canonical user resolves to the verified `open_id` observed
by that application. Explicit `user_id` and `union_id` require a unique verified
observation from that channel with tenant or developer scope respectively. A
command stores the original address and checks its evidence again before sending.
New commands for an established conversation use its chat address. The offline
conversion preserves historical recipient records and cancels queued commands
for unverified provisional recipients. Creating external private contact does
not start the recipient's Main; their next reply does.

## Runner group directory, creation and invitations

`/api/runner/groups` is a channel-scoped local group directory, separate from
the Agent-scoped Dashboard permission groups at `/api/groups?agentId=...`. Search and details
return only group ID, channel ID, provider chat ID, name and local session ID.
`GET /groups/lookup?channelId=...&chatId=...` queries the provider and imports a
known group plus local session. Lookup itself does not send or invite.
User and group directories share the same active-invocation scope implementation.

- GET /api/runner/groups: q, channelId, userId, limit, offset.
- GET /api/runner/groups/:id: local group details.
- GET /api/runner/groups/lookup: exact provider lookup.
- POST /api/runner/groups: channelId, name, idType, memberIds.
- POST /api/runner/groups/invite: channelId, chatId, idType, memberIds.
- GET /api/runner/commands/:id: shared command status and result.

`userId` accepts the canonical Luna user ID for both humans and bots. The
search matches a recorded, non-deleted inbound message in the caller's visible
groups or an active group conversation served by that bot in the same Agent.
Search uses local evidence of participation. It does not refresh Feishu membership.

Creation and invitation require Idempotency-Key. They are durable `group.create`
and `group.invite` commands in the existing worker, not model invocations. Group
creation belongs to the source session; invitations belong to the target group
session. Both share command claiming, cancellation of queued work, ambiguous
restart recovery and explicit duplicate-risk retry. Invitation partial/pending
results are terminal snapshots of the provider response, not polling promises:
`partial` means some IDs failed, `pending_approval` means provider approval is
outstanding, and `completed` means the requested operation was accepted without
these exceptions. `acceptedMemberIds` can include users who were already members.
No automatic re-invitation or membership/approval synchronization is performed.

Creation uses private internal Feishu groups with typed provider user IDs and the
command UUID as provider idempotency key. Success atomically records the group,
local session and command result `{groupId, chatId, sessionId}`.
Missing/ambiguous receipts are unknown; explicit provider rejections are failed.
The source Main is not blocked by group command execution, and creating a group
alone does not start its Main. For creation/invitation-only requests, source Main
reports the result without a welcome, handoff or Task. When the user requests
an introduction or follow-up work, source Main waits for `completed`, then hands
the work request to `result.sessionId`. At group-command acceptance, Service
freezes the triggering message and up to four preceding visible messages from
the source session, plus optional `contextMessageIds` (CLI: repeatable
`--context-message`). The authenticated invocation supplies the trigger; for
non-message invocations, the latest source message visible when that invocation
started is used. No later pending input is silently added on retry.

Each explicit ID must reference a visible, non-deleted source-session message.
Group creation persists the selected IDs in the existing command JSON. Before
calling the provider it rechecks availability. Success atomically binds timeline
references and a `group_launch` context pack with the group/session result.
Message ownership and content stay in the original session; no history is reposted
to Feishu. Replays retain the same selection and do not duplicate references.
Main reads this pack as launch context; Task creation also carries these source
references. Dashboard exposes them as launch context. No schema migration is
needed. Topic creation uses the same default selection with its required anchor;
its existing `contextMessageIds` adds to the window. Handoff remains an execution
request and does not accept message IDs for context transfer.

 The receiving Main owns the introduction
and work: simple introductions need only a reply; Task work follows the same
CLI opening-before-Task sequence as topics. Source Main neither posts the opening
nor creates the new group's Task. Uncertain group creation must be resolved before
handoff; retries retain existing command IDs. The receiving Main does not create
another group/topic or hand back by default. Sending to `--chat-id` remains an
explicit general messaging capability, using the existing outbox.

Provider bot membership,
application availability and group-admin restrictions still apply. Directory
search does not enumerate the entire tenant; exact provider lookup requires a
known chat ID and appropriate bot access.

```sh
luna groups search --query 'project' --channel-id CHANNEL
luna groups search --user-id LUNA_USER_ID
luna groups lookup --channel-id CHANNEL --chat-id oc_xxx
luna groups get LOCAL_GROUP_ID
luna groups create --json '{"name":"Project collaboration","memberIds":["ou_a"],"contextMessageIds":["LUNA_MESSAGE_ID"]}'
luna groups status COMMAND_ID
luna groups invite --json '{"memberIds":["ou_b"]}'
# Only when follow-up work was requested, after creation completes:
luna messages handoff --session-id SESSION --text 'Complete requirements, constraints and expected result' --request-id group-handoff-1
```

`memberIds` uses the current Feishu application's IDs. `idType` defaults to
`open_id` and also supports `user_id` and `union_id`. The service supplies
the current channel and, for invitations, the current group when `chatId`
is omitted. JSON input also accepts `--json --stdin`. The CLI generates a
request ID unless one is supplied. Use an explicit stable ID when retrying.

`luna session create-thread` uses the current invocation's triggering message
as its anchor. An explicit `anchorMessageId` can select a different message
from the current conversation. Optional `contextMessageIds` supplements the
default context window.

## Dashboard conversation input

Dashboard is a direct session entry point, using the same `LunaMessageIngress`
as Feishu through an HTTP ingress adapter. It does not bind an outbound channel. `POST /api/sessions/:id/messages` authenticates the dashboard user and
passes text and an idempotency key to that adapter. It does not create a
`session.invoke` command, context pack, turn, or message record itself.
The shared inbound command router, session resolver, message normalization and
persistence, inbox batching, turn processor, Main Runner and domain command services own
all of those user-message responsibilities. See `messages-and-channels.md` for
direct session access and external channel delivery.

The composer polls the accepted message's ordinary inbox status and the shared
session timeline. Draft/idempotency behavior is unchanged. Legacy dashboard
`session.invoke` records remain historical execution facts; new dashboard input
never uses that path.


## Shared calendar creation through Runner and CLI

Dashboard schedule-editor and POST /api/runner/schedules use
packages/service-client/src/schedule-input.ts for the same recurrence schema, timezone checks,
timing exclusivity, bounds and initial nextAt calculation. Both persist the same
CalendarRule JSON and use SessionCommandService.materializeSchedules and
calendarOccurrence for subsequent occurrences. No runner-mediated rescheduling
or extra timer loop is used. The Runner still requires an active Main or Work invocation,
valid actor and target authorization; calendar options do not change those checks.

Runner nextAt is optional for calendar rules (server computed) and fixed intervals
(default now + interval), required for one-shot tasks. Existing explicit nextAt
and interval requests remain supported. Calendar and interval are mutually
exclusive. Idempotency compares the normalized recurrence and originally
requested nextAt, not the mutable computed nextAt, before timing resolution;
retries after an occurrence reuse the same schedule. Changed rules return 409.

CLI --repeat daily|weekdays|weekly|hourly|monthly|yearly plus --time and --timezone
maps into the shared rule. --days uses Sunday=0 through Saturday=6; --month-days
accepts comma-separated 1–31; --month selects a yearly month. --every and
--start-date select custom anchored cycles; otherwise every defaults to 1 and
the anchor defaults to today's date in the requested timezone. Explicit start
dates and identical arguments are recommended for retries across midnight.
The Main Runner instructions document native calendar recurrence and prohibit
one-shot self-rescheduling as its implementation.


### Dashboard schedule deletion

The schedule detail panel exposes permanent deletion through `DELETE /api/session-commands/schedules/:id`. This is distinct from pause/resume. A running occurrence command blocks deletion with 409. In one synchronous transaction deletion removes the schedule, occurrence history and associated commands, cancels pending message delivery metadata, and removes unused pending invocation context packs. Already delivered messages, executed conversation history and independent tasks remain. The scheduler re-reads the schedule before materialization and command workers claim existing pending rows, so deleted work cannot execute from a stale scheduler snapshot. `schedule_deletions` records the ID and deletion time and rejects late occurrence inserts. The endpoint checks the selected Agent and source scope while the schedule exists. Subsequent requests for an absent ID return 404.

## Runner-controlled replies

Main and Work invoke `luna messages send --purpose answer --request-id <stable-id>
--stdin` (or `--text`) while they are running. `progress` and `notification` are
also supported. The CLI waits up to 30 seconds for `sent`, returning the command
ID, message ID, provider message ID, delivery state and error. A pending timeout
or ambiguous outcome is not success: inspect `luna messages status <id>` and reuse
the request ID instead of creating a duplicate command.

The command queue owns accepted deliveries independently of runner exit. Pending,
running, sent and unknown answer commands retain that ownership; failed commands
do not count as an accepted answer. Logical turn IDs provide retry deduplication.
Task-result reporting uses `task-result:<taskRunId>:<sessionId>` as its stable
origin across Main retries. Pending/unknown task-result commands suppress another
Main invocation; sent commands complete the notification attempt on recovery.
Task Runner has no user-message capability and reports internally to Main.

## Task and session operations

Task and session-state mutations are domain commands, separate from message delivery:
`luna task create|update|restart|cancel`, `luna session create-thread|clarify|release`, and
`luna task status COMMAND_ID` / `luna session status COMMAND_ID`. They use the
runner task/session endpoints and `GET /api/runner/operations/:id`. There is no
generic action API or batch response command.

`runner_operations` stores trusted context and phases `accepted`, `prepared`,
`applied`, or `failed`. Task mutations and preparation commit atomically, then the
Task Supervisor dispatches with a per-operation source ID. Recovery resumes pending
operations without repeating mutations or runs. See [Sessions and Main Runner](sessions-main-runner.md#task-and-state-command-boundary).

Main returns a final reply as text or a `luna.reply` document; the sentinel is
reserved for an already accepted answer or an allowed silent turn. Terminal JSON
never executes business actions.
The old action parser, executor and historical replay paths are removed. Main
returns only execution completion metadata. Existing decision rows are audit data,
not executable recovery instructions. Only command ledgers resume pending work.

## Structured replies

Message commands may carry a normalized `reply` document next to their Markdown
`content` projection. Both CLI `--json` and successful Main/Work final outputs
use the same version-1 schema (text/message/card; ordered text/image/file-link
blocks). Provider-specific payloads and paths are not accepted as media blocks.
Artifacts pass the existing command authorization path; unavailable/non-image
image references fail before delivery. Image upload failure cannot become a
successful text-only message. Existing `--text` calls remain supported.

Final replies use the reserved `service-final-answer` request key and the
original business origin ID. Accepting the command precedes Turn/invocation
settlement, so recovery repeats acceptance without generating another answer.
The Runner API rejects that reserved key. Accepted CLI answers own delivery,
including ambiguous outcomes, and prevent automatic final-output duplication.


`task.cancel` accepts a taskId and optional reason, with Main selecting the target
(including for `/stop`). Its prepared result stores the exact active runId.
Dispatch cancels only that run; retries reuse the same receipt. `cancelled: true`
means cancellation is recorded and termination requested, while false means the
selected run no longer requires cancellation. This command never starts a new Run.

Reply delivery clears processing markers as soon as an answer is sent; turn
finalization also clears them on success, failure or cancellation. Both paths
share per-adapter in-flight deduplication and a bounded recent completion cache
(1,024 messages). Failed cleanup is removed from the cache so finalization can
retry. Adapters must still tolerate repeated cleanup after a process restart or
cache eviction. Marker failures never downgrade an already delivered reply.

Work derives its actor first from the persisted canonical message sender when
that user exists, then legacy channel identity links, then the session creator.
Command authorization still rejects inactive users; an inactive sender is not
replaced with an active owner. Final output is accepted as a durable answer and
status cards report operational completion, rather than swallowing final text.
