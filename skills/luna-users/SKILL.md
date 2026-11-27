---
name: luna-users
description: >-
  Find people and bots and reach them with `luna users`, `luna say`, and `luna ask`: look someone up by name or Feishu ID, send a private message (`--to user:<id>`), open a tracked request (card or multi-turn delegate), or @-mention a person or bot in a group. Use before mentioning anyone or messaging someone outside the current conversation.
---

# Luna people and mentions

Discover people and bots in Luna's directory, then address them with unified `user:<luna-user-id>` addresses:

```bash
luna users search --query '姓名'
luna users search --query '机器人名称' --kind bot
luna users get USER_ID
luna users lookup --channel-id CHANNEL_ID --feishu-user-id ou_xxx --id-type open_id

# Send a one-way private message directly to the user:
luna say --to user:USER_ID --text '消息内容'

# Delegate one-way to that user's private Main session (no return ticket):
luna say --to user:USER_ID --via-main --text '结合你们之前的沟通跟进一下进度'

# Ask someone a tracked request (omit --options for multi-turn conversation; pass --options for quick card buttons):
luna ask --to user:USER_ID --text '请确认今晚发布窗口与回滚负责人'
luna ask --to user:USER_ID --text '请确认是否继续？' --options '["继续","暂缓"]'

# Owner permissions/approvals ALWAYS go privately via --to owner (never in a group); if a group card must lock one signer, pass --actor:
luna ask --to owner --text '是否批准该方案？' --options '["同意","拒绝"]'
luna ask --to current --actor user:USER_ID --text '请确认接口口径' --options '["确认","待调整"]'
```

- Name search queries Luna's visible directory (and in a group, refreshes missing bot/member entries from the current channel adapter). If a person has only a raw Feishu `open_id`/`user_id`/`union_id` and is not yet in the directory, import them once with `luna users lookup`, then use the returned Luna `user.id` (`--to user:<id>`) everywhere.
- Never pass `--feishu-user-id`, `--chat-id`, or `--channel-id` to `luna say`, `luna ask`, or `luna groups create|invite`—only `users lookup` and `groups lookup` take raw channel identifiers.
- For an explicit Feishu group `@`-mention or bot handoff in the current session, use `luna say --purpose answer --json --stdin` (or output a `luna.reply` document directly) with ordered blocks:
  `[{"text":"请 "},{"mention":"LUNA_USER_ID"},{"text":" 检查这个方案。"}]`
  Note: inside a `mention` block, `userId` / `mention` is the raw Luna user ID (`<id>`, without the `user:` address prefix).
- Service does not add quotes or `@`-mentions automatically:
  - `p2p`: keep direct chats unmentioned.
  - `group`: quote (`replyTo`) and mention the human asker in interleaved group chats or delayed `task_result` replies.
  - `thread`: omit `replyTo`; mention only to notify someone or hand off a concrete next step to another bot.
- Never mention yourself or the bot that sent the message unless handing off a specific next step; resolve ambiguous names with the user first. Do not call administrator user APIs.
