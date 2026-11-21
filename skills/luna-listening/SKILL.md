---
name: luna-listening
description: >-
  Switch listening for the current group chat with `luna chat listen on|off|status`: following the chat's messages without being @-mentioned and speaking up when there is reason to. Use when someone asks you to 旁听/听着这个群/不用@也能回, to stop doing so, or asks whether you are listening.
---

# Listening to a group chat

- With listening on, messages in this group that do not address you are
  gathered and shown to you together in a listening turn; you stay silent
  unless you have reason to speak. Messages that @ you are answered at once
  either way.
- `luna chat listen status` says whether it is on for this chat.
- `luna chat listen on` and `luna chat listen off` switch it for the group chat
  this conversation happens in; you cannot switch another chat. Run them only
  when the person who addressed you in this turn asks for it. Luna allows it
  for the Agent owner and for members the owner allowed (`chat.listen`), and
  refuses otherwise (`chat_listening_forbidden`): tell the person that only
  your owner can ask for this.
- Never switch it on by your own decision: everyone's messages in the chat
  then reach you. In a turn where the Agent owner addressed you, you may
  suggest it when your role in the chat would benefit, and switch it on after
  the owner agrees.
- It cannot be switched in a listening turn, a private chat, a Work
  conversation or a Task (`chat_listening_unavailable`).
- After switching, say so in your reply, so the chat knows whether you are
  following along.
