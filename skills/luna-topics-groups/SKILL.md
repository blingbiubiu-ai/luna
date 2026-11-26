---
name: luna-topics-groups
description: Open a Feishu topic (thread), create a group, or invite people to a group, and start or delegate follow-up work in the new topic or group. Use when someone asks to 开话题/新话题, 建群/拉群, 拉人进群/邀请, or to move work into a separate topic or group.
---

# Luna topics and groups

## Topics (`create-thread`)

Task creation never creates a topic automatically. To open a Feishu topic from a group chat and start Task work inside it in one turn (zero extra Main hop):

1. Create the topic and read `targetSessionId` from the receipt:
   ```bash
   luna sessions create-thread --title '播放异常排查'
   ```
   - By default, the current turn's triggering message is the anchor, and Service automatically attaches the anchor plus up to four preceding messages as `thread_launch` context.
   - To anchor to a different message or include older messages, pass `--anchor-message-id <msgId>` and/or `--context-message <olderMsgId>`.
2. Materialize the Feishu topic with one brief colleague-style opening message:
   ```bash
   luna say --to session:TARGET_SESSION_ID --text '收到，我在这个话题里跟进排查播放卡顿问题。'
   ```
3. Launch the Task directly bound to the new topic (`sessionId` inherits `thread_launch` context and attaches the progress card to the topic):
   ```bash
   luna tasks create --stdin <<'EOF'
   {"sessionId":"TARGET_SESSION_ID","title":"播放异常排查","summary":"排查刚才反馈的播放卡顿问题并给出结论","facts":["用户反馈的关键事实"]}
   EOF
   ```
   - **Automatic source silence**: when `create-thread` is anchored to this turn's group message and you send a message or create a Task in `targetSessionId`, Service automatically suppresses duplicate terminal-output reply in the parent group chat. Reply in the parent group only if `create-thread` fails or the topic is anchored to an older message.
   - If instead the new topic needs its own Main to converse with users before deciding on a Task, delegate one-way via `luna say --to session:TARGET_SESSION_ID --via-main --text '<facts and goal>'` (or `luna ask --to session:TARGET_SESSION_ID --text '…'` only when the parent group explicitly wants a final conclusion returned back to the parent group).

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
  3. If the user also asked for an introduction or Task inside the new group, delegate one-way to the new group's Main:
     ```bash
     luna say --to session:RESULT_SESSION_ID --via-main --text '<purpose, requirements, constraints>'
     ```
     The receiving group Main owns the opening (`luna say --purpose answer --text '…'`) and subsequent `luna tasks create` (use `luna ask` instead of `say --via-main` only if a result must be returned back to the source chat).

## Moving or Watching an Existing Task (`tasks transfer` / `watch`)

A Task has **1 primary session** (`primary_session_id`, receiving `luna say/ask --to main`, progress cards, and `task_result`) plus **0..N watcher sessions** (`task_subscriptions`).

- **Live transfer without restarting the Task** (e.g. a Task started in private chat before the bot joined the project/Meego group, or moved into a newly opened topic):
  ```bash
  luna tasks transfer --task-id TASK_ID --to group:GROUP_ID
  luna tasks transfer --task-id TASK_ID --to session:TARGET_SESSION_ID --origin-notify result_only
  ```
  - `--origin-notify none` (default): keeps the previous primary session as a **silent watcher**—no intermediate messages or completion push, while `luna tasks list --session current` and `luna tasks get TASK_ID` still inspect progress anytime on demand.
  - `--origin-notify result_only`: silent during runs/wake-ups, but automatically delivers the final `task_result` to the origin session when the Task finishes (use when the user asks to also be notified of the final result).
  - `--origin-notify major_updates`: keeps both progress cards and final result in the origin session too.
- **Add, adjust, or remove watcher sessions**:
  ```bash
  luna tasks watch --task-id TASK_ID [--to current|owner|session:ID|group:ID] [--notify none|result_only|major_updates]
  luna tasks unwatch --task-id TASK_ID [--to current|session:ID]
  ```
