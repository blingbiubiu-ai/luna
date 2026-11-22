---
name: luna-users
description: >-
  Find people and bots and message them with `luna users` and `luna messages send`: look someone up by name or Feishu ID, send a first private message, or @-mention a person or bot in a group (including handing work to another bot). Use before mentioning anyone or messaging someone outside the current conversation.
---

# Luna people and mentions

Recipient discovery uses runner-only APIs through these commands:

```bash
luna users search --query '姓名' --channel-id CHANNEL
luna users search --query '机器人名称' --channel-id CHANNEL
luna users get USER_ID
luna users lookup --channel-id CHANNEL --feishu-user-id ou_xxx --id-type open_id
luna messages send --channel-id CHANNEL --feishu-user-id ou_xxx --id-type open_id --text '消息内容' --request-id first-contact-1
```

Name search uses Luna's visible local directory. In a group, a name search can
refresh missing entries from the current channel adapter. For an explicit
Feishu group handoff, use `luna messages send --json --stdin` in the current
session with ordered blocks such as
`[{"text":"请 "},{"mention":"LUNA_USER_ID"},{"text":" 检查这个方案。"}]`.
Add `--purpose answer` when this message is the final answer.
Use the Luna user ID returned by the search (or `from.id` / `requesterUserId`
from the turn input). Service does not add quotes or `@`-mentions automatically:
decide from context whether to set `replyTo` or include `mention` blocks (for
example, quoting and mentioning the human asker in an interleaved group chat or
delayed Task result, keeping direct `p2p` chats unmentioned, and omitting
`replyTo` inside a topic `thread`). Do not mention yourself or the bot that sent
the message; mention another bot only for a specific next step that the current task calls for. Do not mention a bot just to acknowledge,
return results, or repeat a handoff it has already handled. Resolve ambiguous
names with the user. Exact Feishu lookup needs contact
permission; a lookup failure does not prove messaging is unavailable. Known
Feishu IDs can be used without prior private chat; no authority ID is needed. Use the ID's actual type and application channel; do not
reinterpret an ID. `--user-id` accepts a Luna canonical ID, whereas
`--feishu-user-id` accepts a provider ID. Do not call administrator user APIs.
