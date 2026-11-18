---
name: luna-topics-groups
description: Open a Feishu topic (thread), create a group, or invite people to a group, and hand follow-up work to the new topic or group in the right order. Use when someone asks to 开话题/新话题, 建群/拉群, 拉人进群/邀请, or to move work into a separate topic or group.
---

# Luna topics and groups

## Topics

Choose where to reply and whether a separate topic is useful. Task creation never
creates a topic automatically. For a Feishu topic, use this order:

1. Call `luna session create-thread`. To add older context, pass
   `--json '{"contextMessageIds":["<historicalMessageId>"]}'`.
   Use Luna message IDs from the current session timeline. The current turn's
   triggering message is the default anchor. Supply `anchorMessageId` when
   the user wants a topic anchored to a different message. Service references the anchor and up to four
   preceding messages from this conversation. `contextMessageIds` adds older
   relevant messages to that default window; it does not replace the window. Optional `title` labels the session.
2. Read `targetSessionId` from the receipt. This only provisions the topic and
   context references; it sends no message and starts no Task.
3. Hand the complete request to that topic's Main with
   `luna messages handoff --session-id <targetSessionId> --request-id topic-handoff-1 --text '<request, constraints and expected result>'`.
   Include the user's requirements and ask the receiving Main to send the opening
   reply first, then create/manage the Task in its own session. Do not send the
   topic opening or create its Task from the source session. A handoff receipt
   means accepted, not that the Task already exists. Reuse its request ID when
   checking/retrying; do not fall back to creating a duplicate Task yourself.
4. The receiving topic Main reads the handoff and selected history. If this is
   actionable new work, first send a brief opening in the current topic using
   `luna messages send --purpose answer --request-id topic-opening-1 --text '…'`.
   Say what you are about to do; do not claim the Task already exists. Wait for
   the sent receipt, then call `luna task create` in the current session (omit
   `sessionId`). The opening materializes the Feishu topic before its progress
   card. Do not create another topic or hand the request back to its source.
   If the request needs clarification, ask it in the topic instead of starting
   a Task. Reuse a matching existing Task rather than duplicating it.
5. After successful creation, finish with `LUNA_NOTHING_TO_SEND` because the
   opening answer already owns this turn's reply. If creation fails after the
   opening was sent, send a concise failure notification before finishing; never
   silently leave a promise of work that did not start. Later Task results go to
   this topic's Main. Progress cards remain enabled by default.

Use `luna session status COMMAND_ID` to inspect the topic receipt.
Task updates and retries retain the bound session and status-card preference.
In an existing topic you can bind the task directly to the current session.
If you disable the progress card, do not promise automatic progress updates.


## Groups

Group discovery and operations use runner-only commands:

```bash
luna groups search --query '项目' --channel-id CHANNEL
luna groups lookup --channel-id CHANNEL --chat-id oc_xxx
luna groups get GROUP_ID
luna groups create --json '{"name":"项目群","memberIds":["ou_a"]}'
luna groups status COMMAND_ID
luna groups invite --json '{"memberIds":["ou_b"]}'
```

Creation and invitation use the current Feishu channel. Invitation defaults to
the current group. Supply `chatId` for another known group on that channel.
`memberIds` accepts Feishu IDs, with `idType` defaulting to `open_id`. Inspect the
command status before using result.chatId or result.sessionId. An invitation result can be `partial` or `pending_approval`: report
invalid/not-existing/pending IDs accurately and never claim everyone joined.
Do not automatically retry unknown or partial invitations under a new request ID.
Group directory search is local; exact lookup imports a provider group and does not create or invite members. Do not use administrator group APIs.

For group creation, separate provisioning from follow-up work:

1. Create the requested group and inspect `luna groups status COMMAND_ID` until
   creation is `completed`. Only then use `result.sessionId`. At acceptance,
   Service automatically selects this turn's triggering message and up to four
   preceding messages as the new group's launch context. Add relevant older
   messages with the `contextMessageIds` array if needed.
   Do not put message IDs in handoff to establish context; selection and binding
   belong to group/topic creation. Pending or unknown
   is not successful creation; do not hand off or create another group to bypass
   an uncertain result.
2. If the request is only to create a group or invite members, report the actual
   outcome in the source conversation and stop. Do not invent a welcome, handoff,
   or Task. If the user also requests an introduction or subsequent work in the
   new group, hand that complete request to `result.sessionId`:
   `luna messages handoff --session-id SESSION --request-id group-handoff-1 --text '<purpose, requirements, constraints and expected result>'`.
   The new group receives only the selected message references, not the entire
   source history. Describe the requested work in handoff; selected messages
   provide the original background. The source Main must not send the group's opening
   or create its Task. Reuse the handoff request ID; acceptance is not completion.
3. The receiving group Main owns the opening and subsequent work. For delegated
   Task work, use the same opening-before-Task sequence as topic Main: send an
   opening answer through CLI in the current group, wait for `sent`, then create
   the Task in the current session. Finish with `LUNA_NOTHING_TO_SEND` after
   success; visibly notify the group if creation fails after the opening. If only
   an introduction or a simple answer was requested, reply directly without a
   Task. Clarify ambiguous requirements in the new group. Do not create another
   group/topic or hand back to the source unless the user requests that routing.
