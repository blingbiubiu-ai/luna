---
name: luna-users
description: >-
  Find people and bots and reach them with `luna users`, `luna say`, and `luna asks`: look someone up by name or Feishu ID, send a private message (`--to user:<id>`), ask a question with options, or @-mention a person or bot in a group. Use before mentioning anyone or messaging someone outside the current conversation.
---

# Luna people and mentions

Discover people and bots in Luna's directory, then address them with unified `user:<luna-user-id>` addresses:

```bash
luna users search --query '姓名'
luna users search --query '机器人名称' --kind bot
luna users get USER_ID
luna users lookup --channel-id CHANNEL_ID --feishu-user-id ou_xxx --id-type open_id

# Send a private message using the unified user address:
luna say --to user:USER_ID --text '消息内容'

# Ask someone a tracked question (with optional Feishu interactive buttons):
luna asks create --to user:USER_ID --question '请确认是否继续？' --options '["继续","暂缓"]'
```

- Name search queries Luna's visible directory (and in a group, refreshes missing bot/member entries from the current channel adapter). If a person has only a raw Feishu `open_id`/`user_id`/`union_id` and is not yet in the directory, import them once with `luna users lookup`, then use the returned Luna `user.id` (`--to user:<id>`) everywhere.
- Never pass `--feishu-user-id`, `--chat-id`, or `--channel-id` to `luna say`, `luna handoff`, `luna asks`, or `luna groups create|invite`—only `users lookup` and `groups lookup` take raw channel identifiers.
- For an explicit Feishu group `@`-mention or bot handoff in the current session, use `luna say --purpose answer --json --stdin` (or output a `luna.reply` document directly) with ordered blocks:
  `[{"text":"请 "},{"mention":"LUNA_USER_ID"},{"text":" 检查这个方案。"}]`
  Note: inside a `mention` block, `userId` / `mention` is the raw Luna user ID (`<id>`, without the `user:` address prefix).
- Service does not add quotes or `@`-mentions automatically:
  - `p2p`: keep direct chats unmentioned.
  - `group`: quote (`replyTo`) and mention the human asker in interleaved group chats or delayed `task_result` replies.
  - `thread`: omit `replyTo`; mention only to notify someone or hand off a concrete next step to another bot.
- Never mention yourself or the bot that sent the message unless handing off a specific next step; resolve ambiguous names with the user first. Do not call administrator user APIs.
