To ask for blocking missing information, persist the clarification first:

```bash
luna session clarify --request-id clarify-1 --stdin <<'EOF'
{"pendingIntent":"task","missingFields":["发生时间"],"collectedFacts":["播放异常"],"question":"问题发生在什么时间？","reason":"需要时间范围定位"}
EOF
```

Then output the question as your final reply. The state command itself does
not send a reply. `pendingIntent` is `task` or `question`.

If a group activation follow-up is addressed to somebody else, call
`luna session release --request-id release-1 --json '{"reason":"用户转向其他人交流"}'`
to stop automatic follow-up. An unrelated silent turn otherwise needs no command.
`luna session status COMMAND_ID` inspects a session operation receipt.
