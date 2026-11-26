# Runner Protocol v2

Runner Protocol v2 (`RUNNER_PROTOCOL_VERSION = 2`) defines the turn input
envelope, speaking rules, unified cross-session & Main⇄Task communication
protocol (`luna say` + `luna ask`), command ledger, derived idempotency,
CLI naming, and capability discovery between Luna Service and Main, Work, and
Task Runners. Legacy commands (`luna asks`, `luna requests`, `luna handoff`, `luna handoffs`),
`luna sessions create-thread --handoff`, `luna tasks report --waiting`, legacy
v1 prompt blocks (`<messages>`, `<trigger>`, `<task_result>`), per-domain
`status` subcommands, `--request-id`, and channel-specific target flags are
removed without compatibility aliases; `/api/runner/*` rejects requests carrying
`x-luna-protocol-version < 2` with `426 protocol_version_unsupported`.

## Turn Input Blocks

Every Main and Work turn presents structured JSON/text blocks in deterministic
order:

1. **`<capabilities>`**: compact per-turn `TurnCapabilitiesSummary`
   (`turn`: `originKind`, `allowSilent`, `terminalOutputMode`, optional
   `routineKind`; plus `commands` on restricted `reflection`/`consolidation`/
   `heartbeat` turns and `outboundGovernance` on heartbeat turns or when quiet
   hours / hourly quota pressure is active). The full `RunnerCapabilitiesManifest`
   (`protocolVersion: 2`, `identity`, `turn`, `commands`, `addressScope`,
   `outboundGovernance`) remains queryable live via `GET /api/runner/whoami`
   (`luna whoami`).
2. **`<memory>`**: injected Agent memory entries for this turn.
3. **`<history>`**: background context (`launchSeed`, `deltaContext`,
   `activationContext`), omitted when empty. `deltaContext` carries both
   overheard group user messages and unseen out-of-band assistant messages
   (`reason: "out_of_band:*"`, `via: "request" | "message" | "schedule" | "routine" | "service"`,
   `originSessionId`, `correlationId`, and correlated `request` snapshots).
4. **`<now>`**: `{ now, weekday, timezone }` in the configured IANA timezone.
5. **`<events>`**: ordered array of `TurnEventEnvelope` items
   `{ id, kind, time, source, actor?, correlationId?, payload }`:
   - `message`: new user or overheard ambient group messages (`surface`,
     `addressing`, `listening`, `items`).
   - `open_request`: active (`open` or `in_progress`) requests targeting the
     current speaker/session.
   - `request_opened`: newly opened multi-turn `delegate` request from another
     session or `task:<id>` (`correlationId` = `requestId`).
   - `request_message`: supplemental message on an open request.
   - `request_update`: progress (`in_progress`) or terminal (`done`, `declined`,
     `expired`, `cancelled`) update returned to `originSessionId`.
   - `peer_message`: one-way `luna say --via-main` message from another session
     or Heartbeat, or non-terminal `luna say --to main` milestone update from a
     running Task (`source: "task:<id>"`).
   - `task_result`: terminal (`completed` or `failed`) Task Run report.
   - `schedule_fired`: scheduled `session.invoke` wake-up.
   - `routine`: Service self-routine (`reflection`, `consolidation`,
     `heartbeat`, `request_expiry`).
   - `clarification`: saved session clarification state.

Task Runner turns receive `<capabilities>`, `<task>`, `<launch_context>` /
`<update_context>`, `<task_events>` (runtime inbox events such as settled
`request_update` responses, `say --to task:<id>` notes, and wake-up triggers),
`<user_input>`, `<memory>`, `<now>`, and `<completion>`.

## Unified `luna say` vs. `luna ask`

All cross-session and Main⇄Task communication separates **one-way speech** from
**tracked request-response**:

- **`luna say` (one-way, zero `correlated_requests` ticket)**:
  - `--to current` (default): sends `progress`, early `answer`, or `notification`
    in the current chat.
  - `--to user:<id>|group:<id>|session:<id>`: delivers a message directly to chat
    participants (`message.send`), surfaced on the target session's next Main
    turn via `<history>.deltaContext`.
  - `--to <address> --via-main`: invokes the target session's Main (`session.invoke`
    with `peer_message`) so it acts with local context without creating a ticket
    or return callback. Heartbeat `self` sessions must pass `--via-main` when
    calling `say`. Also used for post-settlement follow-ups or amendments after
    a `Request` is already `done`.
  - `--to main` (Task Runner only): sends a non-terminal milestone update to the
    subscribed Main session (`peer_message`) while keeping the Task container running.
  - `--to task:<id>` (Main/Work Runner): appends a non-disruptive note to
    `task_inbox_events` without aborting an active Task Run.
- **`luna ask` (tracked response in `correlated_requests` + `correlated_request_events`)**:
  - **Card mode (`luna ask --to <addr> --text '...' --options '[...]'`)**: sends an
    interactive card (`message.send`) settled deterministically by Feishu button
    click or `luna ask reply <id> --done|--declined --text '...'`.
  - **Delegate mode (default, omits `--options`)**: wakes target Main (`request_opened`)
    and stays `open` / `in_progress` across as many turns as needed until settled
    explicitly via `luna ask reply <id> --done|--declined --text '...'`.
  - Both modes default to a **2-hour** expiration window (`askDefaultExpiresMs`),
    overridable via `--expires-in <duration>`. Terminal states (`done`, `declined`,
    `cancelled`, `expired`) are immutable.
  - **Task → Main mid-run questions**: Task Runner calls
    `luna ask --to main --text '...' [--wait 60s]`. When independent parallel work
    exists, omitting `--wait` dispatches the question asynchronously so the Task
    keeps working and receives Main's `request_update` mid-run via `<task_events>`
    (`PostToolUse` / `Stop` hooks). When blocked, `--wait` returns inline on a fast
    reply, or the Task exits cleanly into `waiting` state and Service automatically
    `--resume`s it once Main settles the request.

## Speaking Rules & Service-Enforced Invariants

`capabilities.turn.terminalOutputMode` and `capabilities.turn.allowSilent`
govern how a turn speaks:

- **Passive turns (`terminalOutputMode: "reply_current_session"`)**:
  User messages, `task_result`, `schedule_fired`, `peer_message`,
  `request_opened`, `request_message`, and `request_update` turns keep
  **terminal output as the current-session reply**. `LUNA_NOTHING_TO_SEND` is
  used **only** when `allowSilent` is `true`.
- **Self-routine turns (`terminalOutputMode: "ignored"`)**:
  `reflection`, `consolidation`, and `heartbeat` turns ignore terminal output
  completely—no sentinel required. Speaking outside requires explicit
  `luna say --to <address> --via-main` or `luna ask --to <address> --text '...'`.
- **Task turns (`terminalOutputMode: "ignored_use_tasks_report"`)**:
  Task Runners complete via `luna tasks report`, suspend via `luna tasks pause`,
  or exit cleanly while waiting on an open `Request`.

Service (`finalizeRunnerReply` and `RunnerOperationService`) enforces:

1. **Early Answer Deduplication**: an accepted `message.send` with
   `purpose: "answer"` in the current session suppresses terminal-output reply.
2. **Direct Topic Launch Silence**: when a turn runs `luna sessions create-thread`
   anchored to the current turn's group message AND sends an opening message
   (`luna say --to session:<topicId>`) or creates a Task (`sessionId: <topicId>`)
   in that thread, Service automatically suppresses duplicate terminal-output
   reply in the parent group session—launching Topic Tasks in one turn with zero
   extra Topic Main LLM hop.

## Unified Command Ledger & CLI-Derived Idempotency

All Runner write endpoints return a normalized receipt:

```json
{
  "commandId": "...",
  "kind": "message.send | session.invoke | request | task.create | task.pause | session.create_thread | ...",
  "status": "sent | applied | accepted | open | in_progress | done | pending | deferred | ...",
  "result": {},
  "error": null
}
```

- **Derived Idempotency**: `@luna/cli-support` computes
  `Idempotency-Key = v2_<sha256(invocationSeed, commandName, canonicalPayload, repeatNonce)>`
  automatically (`--request-id` is rejected; `--repeat` generates a fresh nonce).
- **Unified Polling & Inspection**: `GET /api/runner/commands/:id`
  (`luna commands status <id>` and `luna commands wait <id>`) queries across
  `task_report_commands`, `runner_operations`, `correlated_requests`,
  `task_inbox_events`, and `session_commands`.

## CLI Command Surface

| Command | Purpose |
| --- | --- |
| `luna whoami` | Inspect active `<capabilities>` manifest |
| `luna say` | One-way speech: current chat, cross-session (`--via-main`), `--to main`, or `--to task:<id>` |
| `luna ask` / `luna ask reply\|message\|wait\|get\|cancel\|list` | Ask a tracked card or multi-turn question, reply (`--done`/`--progress`/`--declined`), message, wait on, or list requests |
| `luna commands status\|wait` | Inspect or wait on any command receipt |
| `luna tasks list\|get\|progress\|create\|update\|restart\|cancel\|status-card\|pause\|report` | Manage Tasks, suspend into `waiting` (`pause [--wake-in]`), and submit final reports |
| `luna sessions list\|timeline\|messages\|create-thread\|clarify\|release` | Inspect Shadow sessions/timelines and mutate session state |
| `luna schedules create\|list\|get\|update\|pause\|resume\|cancel` | Create (`message.send`, `session.invoke`, `task.run`) and manage schedules |
| `luna activity --since` | Query Shadow activity digest since a timestamp |
| `luna groups search\|get\|lookup\|create\|invite` | Discover, create, and invite into groups using `user:<id>` and `group:<id>` |
| `luna users search\|get\|lookup` | Discover directory users/bots or import by provider ID |
