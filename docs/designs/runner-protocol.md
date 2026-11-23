# Runner Protocol v2

Runner Protocol v2 (`RUNNER_PROTOCOL_VERSION = 2`) defines the turn input
envelope, speaking rules, command ledger, derived idempotency, CLI naming, and
capability discovery between Luna Service and Main, Work, and Task Runners.
Legacy v1 prompt blocks (`<messages>`, `<trigger>`, `<task_result>`), per-domain
`status` subcommands, `--request-id`, and channel-specific target flags are
removed without compatibility aliases; `/api/runner/*` rejects requests carrying
`x-luna-protocol-version < 2` with `426 protocol_version_unsupported`.

## Turn Input Blocks

Every Main and Work turn presents structured JSON/text blocks in deterministic
order:

1. **`<capabilities>`**: `RunnerCapabilitiesManifest` (`protocolVersion: 2`,
   `identity`, `turn`, `commands`, `addressScope`, `outboundGovernance`). Also
   queryable live via `GET /api/runner/whoami` (`luna whoami`).
2. **`<memory>`**: injected Agent memory entries for this turn.
3. **`<history>`**: background context (`launchSeed`, `deltaContext`,
   `activationContext`), omitted when empty.
4. **`<now>`**: `{ now, weekday, timezone }` in the configured IANA timezone.
5. **`<events>`**: ordered array of `TurnEventEnvelope` items
   `{ id, kind, time, source, actor?, correlationId?, payload }`:
   - `message`: new user or overheard ambient group messages (`surface`,
     `addressing`, `listening`, `items`).
   - `pending_ask`: open `ask` requests targeting the current speaker/session.
   - `task_result`: completed, failed, or `waitingForInput` Task Run report.
   - `schedule_fired`: scheduled `session.invoke` wake-up.
   - `handoff`: cross-session or Heartbeat delegation (`correlationId` =
     `requestId`).
   - `request_result`: settled `ask` or `handoff` result returned to
     `originSessionId`.
   - `routine`: Service self-routine (`reflection`, `consolidation`,
     `heartbeat`, `request_expiry`).
   - `clarification`: saved session clarification state.

Task Runner turns receive `<capabilities>`, `<task>` / `<launch_context>` /
`<update_context>` / `<user_input>`, `<memory>`, and `<now>`.

## Speaking Rules: Passive Terminal Reply vs. Proactive Explicit Speech

`capabilities.turn.terminalOutputMode` and `capabilities.turn.allowSilent`
govern how a turn speaks:

- **Passive turns (`terminalOutputMode: "reply_current_session"`)**:
  User messages, `task_result`, `schedule_fired`, `handoff`, and `request_result`
  turns keep **terminal output as the current-session reply**. Delivering the
  final generation at turn settlement avoids an extra tool round-trip and avoids
  exposing Codex/PTY turn-settle tail latency (~5–10s) to queued messages.
  `LUNA_NOTHING_TO_SEND` is used **only** when `allowSilent` is `true` (group
  follow-up, ambient listening, `quiet` Task result, or non-p2p trigger).
- **Self-routine turns (`terminalOutputMode: "ignored"`)**:
  `reflection`, `consolidation`, and `heartbeat` turns ignore terminal output
  completely—no `LUNA_NOTHING_TO_SEND` sentinel is required. Speaking outside
  requires explicit `luna say --to <address>` or `luna handoff --to <address>`.
- **Task turns (`terminalOutputMode: "ignored_use_tasks_report"`)**:
  Task Runners submit reports exclusively via `luna tasks report`.

## Invariants Enforced by Service

Ordering invariants that previously relied on prompt instructions are enforced
directly in Service (`finalizeRunnerReply` and `RunnerOperationService`):

1. **Early Answer Deduplication**: if an invocation has already accepted a
   `message.send` with `purpose: "answer"` in the current session, Service
   automatically suppresses terminal-output reply delivery even if the model
   outputs trailing text instead of `LUNA_NOTHING_TO_SEND`.
2. **Atomic Topic Creation + Handoff**: `luna sessions create-thread --handoff <instruction>`
   creates the Feishu thread, binds launch context, enqueues the correlated
   handoff (`handoffCommandId`, `handoffRequestId`), and—when anchored to the
   current turn's message—automatically suppresses terminal-output reply in the
   source group session.

## Unified Command Ledger & CLI-Derived Idempotency

All Runner write endpoints return a normalized receipt:

```json
{
  "commandId": "...",
  "kind": "message.send | handoff | ask | task.create | session.create_thread | ...",
  "status": "sent | applied | accepted | pending | deferred | ...",
  "result": {},
  "error": null
}
```

- **Derived Idempotency**: `@luna/cli-support` computes
  `Idempotency-Key = v2_<sha256(invocationSeed, commandName, canonicalPayload, repeatNonce)>`
  automatically. `--request-id` is rejected; `--repeat` generates a fresh nonce
  when intentional duplicate execution is needed within one turn.
- **Unified Polling & Inspection**: CLI write commands wait for settlement
  automatically (returning immediately for asynchronous cross-session `ask` and
  `handoff` receipts). `GET /api/runner/commands/:id` (`luna commands status <id>`
  and `luna commands wait <id>`) queries across all four server ledgers
  (`task_report_commands`, `runner_operations`, `correlated_requests`, and
  `session_commands`).

## CLI Command Surface

| Command | Purpose |
| --- | --- |
| `luna whoami` | Inspect active `<capabilities>` manifest |
| `luna say` | Send progress, early answer, or cross-session notification (`--to <address>`) |
| `luna handoff` / `luna handoffs resolve` | Delegate work to `<address>` and resolve correlated handoffs |
| `luna asks create\|answer\|cancel\|list` | Create, answer, cancel, or list correlated questions |
| `luna requests list` | List correlated `ask` and `handoff` requests in this Shadow |
| `luna commands status\|wait` | Inspect or wait on any command receipt |
| `luna tasks list\|get\|progress\|create\|update\|restart\|cancel\|status-card\|report` | Manage Tasks and submit Task Runner reports |
| `luna sessions list\|timeline\|messages\|create-thread\|clarify\|release` | Inspect Shadow sessions/timelines and mutate session state |
| `luna schedules create\|list\|get\|update\|pause\|resume\|cancel` | Create (`message.send`, `session.invoke`, `task.run`) and manage schedules |
| `luna activity --since` | Query Shadow activity digest since a timestamp |
| `luna groups search\|get\|lookup\|create\|invite` | Discover, create, and invite into groups using `user:<id>` and `group:<id>` |
| `luna users search\|get\|lookup` | Discover directory users/bots or import by provider ID |
