# Agent Proactivity

Agent proactivity gives each Shadow an autonomous self-layer, direct scheduled
duty execution, correlated cross-session communication (`ask` and `handoff`),
and outbound governance so a Shadow operates as a proactive digital employee
rather than a purely reactive chatbot.

## Architectural Separation

Proactive work is split across three roles so conversation dispatch never turns
into inline execution:

| Role | Responsibility |
| --- | --- |
| **Self-Routines (`reflection`, `consolidation`, `heartbeat`, `request_expiry`)** | Service-driven internal passes that maintain memory, inspect recent Shadow activity, expire overdue requests, and delegate follow-ups |
| **Conversation Coordinator (`Main Runner`)** | Owns one session's conversation tone, context, task dispatch, and final user-facing replies; never runs external project/inspection work inline |
| **Background Executor (`Task Runner` via `task.run`)** | Runs recurring duties and multi-step inspections directly in `quiet` mode (`sendStatusCard: false`), submitting reports for Main to filter or surface |

## Configuration Model

Every proactivity parameter is configured at the platform level
(`PlatformRuntimeSettings.proactivity`) with nullable per-Agent overrides
(`AgentSettings.proactivity` resolved via `resolveProactivitySettings(db, agentId)`):

- `heartbeatIntervalMs` (default `30m`, `0` disables): minimum interval between
  Shadow heartbeat turns.
- `outboundPerSessionPerHour` (default `3`, `0` unlimited): proactive outbound
  cap per target session per rolling hour.
- `outboundPerRecipientPerDay` (default `10`, `0` unlimited): proactive direct
  message cap per recipient per rolling 24 hours.
- `outboundDedupWindowMs` (default `24h`, `0` disables): suppresses identical
  proactive notifications sent to the same session within the window.
- `quietHours` (`{ start: "HH:mm", end: "HH:mm" } | null`, Agent override may
  also set `false` to explicitly disable platform quiet hours): defers proactive
  notifications into `status = "deferred"` until the window ends.
- `askDefaultExpiresMs` (default `2h`): default expiration window for correlated
  `ask` requests.
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
   Heartbeat delegates conversation follow-ups to the target session's Main via
   `luna handoff` rather than speaking out of context, and logs actions in
   `$HOME/heartbeat/journal.md`.
4. **`request_expiry`** (`request-expiry:`): marks overdue `correlated_requests`
   as `expired` and enqueues a `request_result` return into `originSessionId`.

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
require owner approval via `luna asks create` before provisioning.

## Unified Addressing & Correlated Requests

All Runner commands address conversations uniformly via `src/messaging/luna-address.ts`:

- `current` — the invocation's current session
- `self` — this Shadow's dedicated `"心跳"` local session
- `user:<luna-user-id>` — direct (`p2p` or local) session with that user in this Shadow
- `session:<session-id>` — an existing session in this Shadow
- `group:<group-id>` — group session for a directory surface in this Shadow

`correlated_requests` tracks cross-session `ask` and `handoff` lifecycles:

- **`luna asks create`**: sends a question to `targetAddress` (rendering Feishu
  interactive card action buttons when `--options` are supplied) and records a
  `pending` request. Resolution happens either deterministically via Feishu
  `card.action.trigger` button click (updating the card and returning a toast
  without an extra LLM turn) or via `luna asks answer <id>` when answered in
  natural language (surfaced to the target session via `pending_ask` in
  `<events>`).
- **`luna handoff`**: wakes `targetAddress` with a correlated `handoff` event;
  the target session settles it via `luna handoffs resolve <id> --summary ...`
  (or `--declined --reason ...`).
- Whenever an `ask` or `handoff` settles (`answered`, `done`, `declined`,
  `expired`), `CorrelatedRequestService` queues a `session.invoke` carrying
  `requestResult` back to `originSessionId`, delivered as a `request_result`
  event in `<events>`.

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
