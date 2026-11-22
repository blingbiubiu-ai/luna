# Agent Proactivity and Runner Protocol v2 Implementation Record

**Date:** 2026-11-22  
**Branch:** `feat/agent-proactivity`

## Scope

Implemented the three-stage Proactive Digital Employee architecture and Runner
Protocol v2 cutover across database schema, runtime services, Feishu channel
callbacks, CLI, Runner prompts/skills, Dashboard UI, tests, and architecture
documentation:

1. **Stage 1 — Self-Layer & Duty Execution**
   - Added platform-configurable proactivity defaults
     (`PlatformRuntimeSettings.proactivity`) and per-Agent nullable overrides
     (`AgentSettings.proactivity`), surfaced in Platform Settings and Agent
     Settings ("主动").
   - Extracted generic `SelfRoutine` framework (`src/agents/self-routines/`),
     migrated memory `reflection` and `consolidation`, and added per-Shadow
     `heartbeat` (`shadow_heartbeats`, dedicated `"心跳"` local session,
     activity-gated wake-up, `shadowSelf` memory viewer) and `request_expiry`.
   - Added direct `task.run` schedule execution (`ScheduledTaskExecutor` ->
     `TaskRunSupervisor.restartTaskRun` with `quiet: true`), Shadow
     self-management routes (`schedules`, `sessions`, `activity`), rate-limited
     schedule failure notifications (`schedule_failure_notifications`),
     `skills/luna-duties/SKILL.md`, and the mandatory keep-promises (`说到做到`)
     rule.

2. **Stage 2 — Proactive Communication Loop**
   - Implemented unified Luna addressing (`current`, `self`, `user:<id>`,
     `session:<id>`, `group:<id>`) across messaging, handoffs, asks, schedules,
     and group membership commands.
   - Added `correlated_requests` (`ask` and `handoff`) with automatic
     `request_result` return to `originSessionId`.
   - Added Feishu interactive `actions` reply block and deterministic
     `card.action.trigger` callback handling (`CorrelatedRequestService.handleCardAction`).
   - Added `outbound-governance.ts` enforcing per-session hourly caps,
     per-recipient daily caps, content deduplication windows, quiet-hours
     deferral (`status = "deferred"`), and session timeline control events.

3. **Stage 3 — Runner Protocol v2 Cutover**
   - Replaced `<messages>`, `<trigger>`, and `<task_result>` with `<capabilities>`
     + `<events>` across Main and Work turns; added `GET /api/runner/whoami` and
     `426` version enforcement.
   - Retained terminal-output-as-reply for passive turns (avoiding PTY settle
     latency), ignored terminal output for self-routine turns, and moved early
     `answer` and atomic `sessions create-thread --handoff` duplicate-reply
     suppression into Service.
   - Unified command inspection under `GET /api/runner/commands/:id`
     (`luna commands status|wait`) with CLI-derived idempotency keys and
     normalized Protocol v2 CLI commands (`say`, `handoff`, `handoffs`, `asks`,
     `requests`, `tasks`, `sessions`, `schedules`, `activity`, `whoami`).
