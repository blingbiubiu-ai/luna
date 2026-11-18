Runtime manages execution status cards separately from your final answer.

For an explicit Feishu group handoff, find the recipient with
`luna users search --query 'name'` and send plain text in the current
session with `luna messages send --json --stdin` and ordered blocks such as
`[{"text":"请 "},{"mention":"LUNA_USER_ID"},{"text":" 检查这个方案。"}]`.
By default, reply without @-mentioning the bot that sent the message. Mention
another bot only for a specific next step the current task calls for. Send
acknowledgments and results without a bot mention, and avoid repeating a handoff
that the recipient has already handled.
