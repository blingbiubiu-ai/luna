# Agent Proactivity

Agent proactivity gives each Shadow an autonomous self-layer, direct scheduled
duty execution, unified cross-session & Main⇄Task communication (`luna say` and
`luna ask`), and outbound governance so a Shadow operates as a proactive
digital employee rather than a purely reactive chatbot.

## Architectural Separation

Proactive work is split across three roles so conversation dispatch never turns
into inline execution:

| Role | Responsibility |
| --- | --- |
| **Self-Routines (`reflection`, `consolidation`, `heartbeat`, `request_expiry`)** | Service-driven internal passes that maintain memory, inspect recent Shadow activity, expire overdue requests, and delegate follow-ups |
| **Conversation Coordinator (`Main Runner`)** | Owns one session's conversation tone, context, task dispatch, and final user-facing replies; never runs external project/inspection work inline |
| **Background Executor (`Task Runner` via `task.run`)** | Runs recurring duties and multi-stage complex tasks (suspending into `waiting` when blocked on questions or timers), submitting milestone updates or final reports for Main to filter or surface |

## Configuration Model

Every proactivity parameter is configured at the platform level
(`PlatformRuntimeSettings.proactivity`) with nullable per-Agent overrides
(`AgentSettings.proactivity` resolved via `resolveProactivitySettings(db, agentId)`):

- `heartbeatIntervalMs` (default `30m`, `0` disables): minimum interval between
  Shadow heartbeat turns.
- `heartbeatApprovalRequired` (default `true`): requires Heartbeat proactive
  follow-ups targeting other sessions to obtain Agent owner approval via an
  interactive `luna ask --to owner --options '[...]' --text '...'` card before
  Service permits cross-session `luna say --via-main`, `luna ask`,
  or schedules. Exposed live in `<capabilities>.outboundGovernance.heartbeatApprovalRequired`
  and toggleable per-Platform or per-Agent once an Agent's proactive judgment stabilizes.
- `outboundPerSessionPerHour` (default `3`, `0` unlimited): proactive outbound
  cap per target session per rolling hour.
- `outboundPerRecipientPerDay` (default `10`, `0` unlimited): proactive direct
  message cap per recipient per rolling 24 hours.
- `outboundDedupWindowMs` (default `24h`, `0` disables): suppresses identical
  proactive notifications sent to the same session within the window.
- `quietHours` (`{ start: "HH:mm", end: "HH:mm" } | null`, Agent override may
  also set `false` to explicitly disable platform quiet hours): defers proactive
  notifications into `status = "deferred"` until the window ends.
- `askDefaultExpiresMs` (default `2h`): default expiration window for both
  `card` and `delegate` modes of `luna ask` (overridable per request
  via `--expires-in`).
- `scheduleFailureNotifyIntervalMs` (default `24h`, `0` disables): rate-limit
  interval for notifying the Agent owner when a scheduled occurrence fails.

## Self-Routine Framework

`src/agents/self-routines/` provides the shared `SelfRoutine<TCandidate>`
contract and primitives (`ensureDedicatedLocalSession`, `sessionBusy`,
`prepareSelfRoutineRun`, `runSelfRoutines`). All routines execute on the
`SessionCommandService` maintenance loop with per-routine and per-candidate
fault isolation:

1. **`reflection`** (`memory-reflection:`): runs in the idle conversation
   session after `reflectionIdleMs` to capture durable memories and `episode`
   entries.
2. **`consolidation`** (`memory-consolidation:`): runs in the Agent's dedicated
   `"记忆整理"` local session with a fresh provider context to deduplicate and
   reconcile changed memories across Shadows.
3. **`heartbeat`** (`shadow-heartbeat:`): runs per active Shadow in a dedicated
   `"心跳"` local session (`shadow_heartbeats`) with a fresh provider context
   (`src/prompts/heartbeat/role.md`) and `shadowSelf` memory viewer access (sees
   this Shadow's `persona`, `core`, `chat`, and `person` entries, never another
   Shadow's private entries). Heartbeat wakes **only** when new human messages,
   settled Task Runs, or settled schedule occurrences occurred since
   `coveredThrough`; the Agent's own replies never re-trigger heartbeat.
   Heartbeat delegates one-way follow-ups to the target session's Main via
   `luna say --to <address> --via-main` (never speaking out of context directly;
   Service rejects Heartbeat `say` without `--via-main`) or uses
   `luna ask` when a tracked verdict is required, logging actions in
   `$HOME/heartbeat/journal.md`.
4. **`request_expiry`** (`request-expiry:`): marks overdue `open` or
   `in_progress` rows in `correlated_requests` as `expired` and routes
   `request_update` back to `originSessionId` (or appends `request_update` to
   `task_inbox_events` and auto-resumes a `waiting` `originTaskId`).

## Self-Management & Direct Duty Schedules (`task.run`)

Runners inspect and manage their own Shadow's state through `/api/runner/*`:

- `luna schedules create | list | get | update | pause | resume | cancel`
- `luna sessions list [--kind local|p2p|group|thread] [--with-user user:<id>]`
- `luna activity --since <ISO-8601-or-ms>`

Schedule actions support three kinds:

- `message.send`: delivers fixed reminder text directly.
- `session.invoke`: wakes the target session's Main with `schedule_fired`.
- `task.run`: invokes `TaskRunSupervisor.restartTaskRun(taskId, { quiet: true, promptSummary })`
  directly without waking Main first. Overlap (`skip`) checks both active
  occurrence commands and active `task_runs`. When a schedule occurrence fails,
  `schedule_failure_notifications` records `lastFailure` for the Dashboard and
  sends a rate-limited alert to the Agent owner's direct session when available.

Standing duties (`skills/luna-duties/SKILL.md`) combine a Shadow-scoped
`procedure` memory entry, `$HOME/duties/<slug>/` state files, a persistent Task
(`sendStatusCard: false`), and a `task.run` schedule. Non-owner duty requests
require owner approval via `luna ask --to owner --options '[...]' --text '...'`
before provisioning.

## Unified Addressing, `say`, and `ask`

All Runner commands address conversations and Tasks uniformly via
`src/messaging/luna-address.ts`:

- `current` — the invocation's current session
- `self` — this Shadow's dedicated `"心跳"` local session
- `owner` — server-resolved direct (`p2p` or local) session for the Agent owner
  (derived from the signed `LUNA_ACCESS_TOKEN` Agent scope without exposing or
  trusting caller-supplied UUIDs)
- `main` — (Task Runner only) the Task's primary or subscribed Main session
- `task:<task-id>` — a Task in this Shadow (for non-disruptive `say --to task:<id>`
  runtime notes into `task_inbox_events`)
- `user:<luna-user-id>` — direct (`p2p` or local) session with that user in this Shadow
- `session:<session-id>` — an existing session in this Shadow
- `group:<group-id>` — group session for a directory surface in this Shadow

`correlated_requests` and `correlated_request_events` track `luna ask`
lifecycles (`mode: "card" | "delegate"`, `status: "open" | "in_progress" | "done" | "declined" | "expired" | "failed" | "cancelled"`):

- **Card mode (`luna ask --to <addr> --text '...' --options '[...]'`)**: delivers an
  interactive card (`message.send`) to `targetAddress` and records an `open`
  request. Settlement happens either via Feishu `card.action.trigger` button
  click (updating the card and returning a toast without an extra LLM turn) or
  via `luna ask reply <id> --done|--declined --text '...'` when answered in chat
  (surfaced via `open_request` in `<events>`). The target session's next Main
  turn receives the delivered card once in `<history>.deltaContext`
  (`via: "request"`, including its settled `request` outcome when clicked).
- **Delegate mode (`luna ask` without `--options`)**: wakes
  `targetAddress` with `request_opened` and remains `open` / `in_progress` across
  multiple conversation turns until target Main calls
  `luna ask reply <id> --done|--declined --text '...'` (optional
  interim updates use `--progress`). Post-settlement follow-ups or corrections
  use one-way `luna say --to session:<originSessionId> --via-main`.
- **Return routing & Task auto-resume**: updates to a Session-originated request
  queue `session.invoke` (`requestUpdate`, including `resolvedByRole: "owner" | "member"`)
  to `originSessionId` (preserving the original outbound `actorUserId` when
  `resolvedByUserId` is absent). Updates to a Task-originated request write
  `request_update` into `task_inbox_events`, satisfy any active `--wait` caller,
  and automatically resume the Task via `TaskRunSupervisor` if the Task is in
  `waiting` state.
- **Memory-Driven Owner Approval Loop**: when a non-owner requests external
  writes or standing duties (or matches an owner-defined approval rule in
  `persona` / `chat` memory), Main Runner sends an interactive Feishu card
  (`luna ask --to owner --options '[...]' --text '...'`). `CorrelatedRequestService`
  enforces `targetUserId` across Feishu card clicks, Dashboard actions, and
  `updateRequest`, updates the card in-place, and returns `request_update` to
  the group session; `RunnerOperationService` allows that trigger turn's
  `luna tasks create` to link the original requester's `sourceMessageIds` from
  the session timeline.

## Outbound Governance

`evaluateOutboundGovernance` (`src/messaging/outbound-governance.ts`) governs
proactive outbound `message.send` commands (cross-session sends, schedule/trigger
sends, and self-routine sends) while exempting passive replies (`purpose: "answer"`
or `"progress"` in the originating user turn):

- **Deduplication & Rate Caps**: enforces `outboundDedupWindowMs`,
  `outboundPerSessionPerHour`, and `outboundPerRecipientPerDay`, rejecting
  violations with `429 outbound_throttled` and recording an `outbound_throttled`
  session timeline control event.
- **Quiet Hours Deferral**: proactive sends inside `quietHours` are persisted
  with `status = "deferred"`, `availableAt = windowEndMs`, and an
  `outbound_deferred` timeline event, then automatically released to `"pending"`
  once quiet hours end.
