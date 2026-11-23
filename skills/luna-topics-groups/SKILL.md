---
name: luna-topics-groups
description: Open a Feishu topic (thread), create a group, or invite people to a group, and hand follow-up work to the new topic or group. Use when someone asks to 开话题/新话题, 建群/拉群, 拉人进群/邀请, or to move work into a separate topic or group.
---

# Luna topics and groups

## Topics (`create-thread`)

Task creation never creates a topic automatically. To open a Feishu topic from a group chat and hand work into it atomically:

1. Call `luna sessions create-thread` with `--handoff`:
   ```bash
   luna sessions create-thread --title '播放异常排查' \
     --handoff '排查刚才反馈的播放卡顿问题并给出结论'
   ```
   - By default, the current turn's triggering message is the anchor, and Service automatically attaches the anchor plus up to four preceding messages as launch context.
   - To anchor to a different message or include older messages, pass `--anchor-message-id <msgId>` and/or `--context-message <olderMsgId>` (or `--json '{"anchorMessageId":"...","contextMessageIds":["..."],"handoffInstruction":"..."}'`).
   - Pass only this request's facts, goal, and constraints in `--handoff`; never copy `<soul>`/`<memory>` rules or Runner workflow instructions into it.
   - **Automatic source silence**: when `create-thread --handoff` is anchored to this turn's group message, Service dispatches the handoff (`handoffCommandId`, `handoffRequestId`) and automatically suppresses duplicate terminal-output reply in the source group chat. Reply in the source group only if `create-thread` fails or the topic is anchored to an older message.
2. On the receiving topic Main's `handoff` event turn, `$LUNA_SESSION_ID` (`current`) **is** the Feishu topic (`source` is the parent group chat—never reply to `source` unless asked):
   - For actionable new Task work, first send one brief colleague-style opening in the topic with `luna say --purpose answer --text '…'` (materializes the Feishu topic before its progress card; Service automatically suppresses duplicate terminal output once an `answer` is sent), then call `luna tasks create` in the current session.
   - If `luna tasks create` fails after the opening, send a brief failure notice with `luna say --text '…'`.
   - When the delegated topic work concludes, settle the correlated handoff if needed with `luna handoffs resolve <correlationId> --summary '…'`.

Use `luna commands status <commandId>` to inspect any operation receipt.

## Groups

Group discovery and operations use unified Luna addresses (`user:<id>`, `group:<id>`):

```bash
luna groups search --query '项目' [--user user:USER_ID]
luna groups get GROUP_ID
luna groups lookup --channel-id CHANNEL_ID --chat-id oc_xxx
luna groups create --name '项目群' --member user:USER_A --member user:USER_B [--context-message MSG_ID]
luna groups invite [--to group:GROUP_ID] --member user:USER_C
```

- Resolve members first with `luna users search` so you pass `user:<luna-user-id>` to `--member`.
- `groups create` and `groups invite` run on the current Feishu channel and wait for terminal command status (`luna commands wait <commandId>` if timed out).
- Invitation defaults to the current group; pass `--to group:<group-id>` to invite into another known group on the same channel. An invitation result can be `partial` or `pending_approval`: report invalid/not-existing/pending members accurately and never claim everyone joined.
- For group creation with follow-up work inside the new group:
  1. Run `luna groups create` and read `result.sessionId` from the settled receipt (Service automatically attaches the triggering message and up to four preceding messages as launch context; add older ones with `--context-message`).
  2. If the user only asked to create the group or invite members, report the outcome in the source conversation and stop.
  3. If the user also asked for an introduction or Task inside the new group, hand that request to the new group session:
     ```bash
     luna handoff --to session:RESULT_SESSION_ID --text '<purpose, requirements, constraints and expected result>'
     ```
     The receiving group Main owns the opening (`luna say --purpose answer --text '…'`) and subsequent `luna tasks create`.
