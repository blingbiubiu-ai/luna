# Platform Accounts And Agent Users (proposal)

Status: implemented. Based on `main` at `139f987`.

## Problem

`users` is one global table. A Dashboard login, a Feishu sender, another bot in a
group and a Shadow's reply account are all rows in it, and a verified
`user_id`/`union_id` claim merges the same person across Agents into one row.
Since `e231731`, users, groups, memberships and grants are Agent-owned and
managed by the Agent owner, but the row they act on is still platform-wide:

- an `@` label seen in Agent A renames the person in every Agent
  (`IdentityDirectory.applyMentionDisplayName`);
- deleting a user revokes all tokens and disables schedules in every Agent
  (`deleteDashboardUser`), so it stays platform-admin-only;
- a wrong cross-Agent merge affects every Agent, and two Agents of different
  owners share one contact record;
- the Users page has to derive "who belongs to this Agent" on every request
  (`agentUserVisibility`).

## Model

Two kinds of identity:

- **Account** (`accounts`, new): someone who signs in to the Dashboard. Owns
  Agents, holds personal CLI/MCP tokens, can hold the platform `system.admin`
  grant. Kind is always human.
- **User** (`users`, existing table, gains `agent_id`): someone or something
  inside one Agent — a Feishu sender, another bot, a Shadow reply account, and
  the owner as they appear in that Agent. Every Agent-scoped row references a
  user of the same Agent.

An Agent is to Luna what a workspace is to Slack: the account is global and
signs in; the user is who that account, or anyone else, is inside one
workspace. Almost all runtime code works inside one Agent (message sender,
session creator, task creator, memory subject, grant subject, runner actor), so
the common concept gets the short name `user`; the platform concept appears
only at sign-in, tokens, Agent ownership and platform administration.
`member` is not used for Agent users because they include outside bots and the
Shadows themselves; it stays with group membership. `contact` is not used
because it excludes the owner and the Shadows.

### Naming rules

| Layer | Table | Code type / id | UI term |
|---|---|---|---|
| Platform | `accounts` | `Account`, `accountId` | 账号 |
| Agent | `users` | `User`, `userId` | 用户 |
| Agent ownership | `luna_agents.owner_account_id` | `ownerAccountId` | 所有者 |
| Group membership | `group_memberships.user_id` (unchanged) | | 成员 |

- A column that references an account ends in `_account_id`; one that
  references an Agent user ends in `_user_id`. Bare `created_by`, `updated_by`
  and `activated_by` columns gain the suffix, so every reference says which
  layer it points to.
- `userId` in code always means an Agent user. Code that holds an account says
  `accountId`; there is no unqualified "user" for a Dashboard login.
- User `kind` is `human`, `bot` or `shadow`. `shadow` replaces `system` for
  Shadow reply users; `agent_shadows.reply_user_id` keeps its name, since it is
  a user of the Agent.
- HTTP: `/api/accounts` for platform accounts (admin) and `/api/auth/*` for the
  signed-in account; `/api/agents/:agentId/users` replaces `/api/users?agentId=`.
  The Runner CLI `luna users` is unchanged: it already lists Agent users.

### `accounts`

| Column | Meaning |
|---|---|
| `id` | Account id; for a Dashboard login, the id the login provider returns (`DashboardAuthUser.id`) |
| `display_name`, `avatar_url` | Profile from login |
| `status` | `active`, `disabled`, `deleted` |
| `created_at`, `updated_at` | |

### `users` changes

| Column | Change |
|---|---|
| `agent_id` | New, required, FK `luna_agents`. A user exists in exactly one Agent |
| `account_id` | New, nullable, FK `accounts`. Set when this user is an account in this Agent; unique per `(agent_id, account_id)` |
| `kind` | `human`, `bot`, `shadow` (Shadow reply users; was `system`) |
| `status` | `active`, `blocked` (messages refused), `removed` (off the list; a new message restores `active`), `merged` |
| `display_name`, `profile_source` | Unchanged columns, now naturally per Agent |

The owner of an Agent is the user with `account_id = luna_agents.owner_account_id`.
It is created with the Agent, so every Agent always has an owner user.

### Identity evidence

- `channel_identities` are already per channel config, and channel configs
  belong to one Agent. The Dashboard channel (`luna-dashboard`) is global today;
  Dashboard messages instead resolve to the requesting account's user in that
  Agent.
- `user_identity_links` gains `agent_id` and its unique key becomes
  `(agent_id, namespace, kind, value, scope)`. `open_id`/`user_id`/`union_id`
  still merge one person across the Shadows' apps of one Agent, never across
  Agents.
- `materializeIdentityClaims` takes the Agent from the channel config and only
  resolves or creates users of that Agent.

## Reference map

Platform side, referencing `accounts`:

| Column (old name → new name) | Why |
|---|---|
| `luna_agents.owner_user_id` → `owner_account_id` | Ownership |
| `access_tokens.user_id` → `account_id` for personal tokens (`agent_id IS NULL`) | Personal CLI/MCP tokens. Runner tokens keep `user_id`; a check requires exactly one of the two |
| `cli_auth_sessions.approved_by_user_id` → `approved_by_account_id` | CLI login approval |
| `authorization_rules.subject_id` for platform-scope rules | `system.admin`; the column stays polymorphic, the scope says which layer |
| `agent_profiles.created_by`, `agent_profile_revisions.created_by` → `created_by_account_id` | Dashboard configuration audit |
| `agent_profile_secrets`, `agent_plugin_configs`, `agent_worker_access`, `shadow_model_selections`, `shadow_worker_routing`, `shadow_root_access`: `updated_by` → `updated_by_account_id` | Dashboard configuration audit |
| `active_agent_config.activated_by` → `activated_by_account_id` | Dashboard configuration audit |
| `agent_lifecycle_jobs.actor_user_id`, `agent_mutation_receipts.actor_user_id` → `actor_account_id` | Dashboard configuration audit |

Agent side, referencing `users` of the row's Agent; the same-Agent rule is
checked where the row is written:

| Column | Agent found through |
|---|---|
| `messages.sender_user_id` | `agent_id` |
| `sessions.created_by_user_id`, `sessions.bot_user_id` | `agent_id` |
| `session_commands.actor_user_id`, `session_schedules.actor_user_id`, `timeline_events.actor_user_id` | session |
| `tasks.creator_user_id`, `task_participants.user_id`, `task_report_commands.actor_user_id` | task |
| `runner_invocations.actor_user_id`, `access_tokens.user_id` where `agent_id` is set | `agent_id` |
| `agent_memories.origin_user_id`, `subject_user_id`, `participants_json` | `agent_id` |
| `agent_memory_revisions.changed_by_user_id` | memory |
| `group_memberships.user_id` | group |
| `channel_auth_tokens.user_id` | channel (the sender's user; `#auth` and `#link` tokens) |
| `authorization_rules.subject_id` for Agent-scope user rules | `agent_id` |
| `operation_invocation_audits.subject_id`, `managed_artifacts.related_user_id` | `agent_id` |
| `agent_shadows.reply_user_id` | `agent_id` (already one Agent) |

Ids inside JSON payloads (`input_snapshot_json`, command and trigger payloads)
follow the same rule.

## Behaviour changes

- **Owner checks**: the 11 `ownerUserId === actorUserId` comparisons
  (`agent-store`, `session-access`, `task-access`, `agent-memory-access`,
  `agent-memory-maintenance`, `shadow-root-access-store`, `worker-gateway`)
  move to one helper. Dashboard routes compare accounts; runtime paths ask
  whether the acting user is the owner user.
- **Dashboard requests**: the session's account is resolved to its user in the
  path's Agent; only the owner's account has one today.
- **Users page**: lists `users WHERE agent_id = ?`; `agentUserVisibility` and
  `requireAgentUser` become a scope check. "Delete" becomes remove/block, owned
  by the Agent owner. Deleting an account moves to a platform admin page.
- **Names**: an `@` label or manual rename changes only that Agent's user.
- **Ingress**: messages from a `blocked` user are not persisted into a session
  and start no Runner.
- **Memory, grants, groups**: unchanged logic; ids now come from one Agent.

## Linking an account to its channel identity

Today the owner's Dashboard login and their Feishu sender are two unrelated
rows, so a Feishu message from the owner is not treated as the owner. Linking
proves that one person holds both, and works only on what every channel adapter
already produces after normalization, never on provider fields:

- `NormalizedInboundMessage.sender` (a `ChannelIdentity`) with its scoped,
  verified `identityClaims` and `requesterIdentity`;
- the persisted channel identity from `ChannelDirectoryStore.upsertIdentity`;
- the user it resolves to through `channel_user_bindings` or verified claims.

A channel that cannot name its sender explicitly
(`requiresExplicitRequesterIdentity` without a `requesterIdentity`) cannot be
linked, as `#auth` already refuses it.

### Flow

It reuses the `#auth` system command path (`InboundCommandRouter`) and
`channel_auth_tokens`, with a new purpose `account_link`:

1. The person sends `#link` in a direct chat with any Shadow bot of the Agent.
   The command is handled before the message enters a session or a Runner.
   Group chats are refused.
2. Service resolves the sender to its user in that Agent and issues a one-time
   token (10 minutes, single use) recording the channel, the channel identity
   and that user, and sends it back in the same direct chat.
3. Signed in to the Dashboard, the owner pastes it on the Agent's account page.
   The Dashboard first shows who will be linked: name, avatar, channel and
   Shadow, from the stored channel identity. The owner confirms.
4. In one transaction Service checks that the token is unconsumed and unexpired,
   that its channel belongs to this Agent, and that the requester is the
   owner account; then merges the sender's user into the owner user (below) and
   consumes the token.

The token travels from the channel to the Dashboard, not the other way: the
confirmation screen shows whose identity is being linked, so a token someone
else sent to the owner is visible as someone else's before it takes effect.

### Merge

The sender's user moves into the owner user of the same Agent:

- its channel bindings and verified identity links move to the owner user, so
  the same person writing through another Shadow's app resolves to the owner
  as well when a tenant- or developer-scoped claim matches; a channel without
  such claims needs one link per Shadow app;
- its references in this Agent (messages, sessions, tasks, memory subject,
  author and participants, group memberships, grants) are rewritten to the
  owner user; after the split they are all inside this Agent, so the rewrite is
  bounded;
- the old row becomes `merged` with `merged_into_user_id`.

Refused: a sender that is a bot or Shadow user, a sender whose user already
belongs to another account, a channel of another Agent, the Dashboard channel.

### Unlink

The owner can unlink a channel identity from the Agent's account page. It is
re-bound to a new user of the Agent; what happened while it was linked stays
with the owner user.

### Effect

Messages from the linked identity act as the owner: owner checks pass, memory
the owner writes is trusted, and the owner sees every episode. Linking is per
Agent; owning two Agents means linking in each, which keeps the Agents
independent.

## No in-place upgrade

Existing databases are not upgraded. Migrations `0001`–`0005` are squashed with
this change into a new `0001` baseline. `assertDatabaseBaseline` already
refuses a database whose first migration differs, with
`database_baseline_mismatch` and the instruction to back up and run
`luna service db reset`. Sessions, messages, tasks, memory, artifacts, users,
groups and grants of an old database are not carried over. A local Worker is
bound again to the new Service (`luna-worker bind`), as after any reset.

### Configuration import

To set up a new database from an old one, mainly for testing, an operator
command copies configuration only:

```
luna-service admin import-config --home <new home> --from <old luna.db> --owner <account id>
```

It runs against a fresh, migrated database, with the Service stopped and the
old database opened read-only. It reads the old schema with plain SQL, not
through the current Drizzle schema, so it does not depend on old code.

| Imported | How |
|---|---|
| Active Agents and their active Shadows (name, default Shadow) | Recreated through `AgentStore` for the given owner account; owner user and Shadow users are created as usual |
| Feishu channel configs (`app_id`, App Secret, chat id, enabled) and their Shadow bot bindings | App Secret decrypted with the old key and saved through the channel config store, which re-encrypts it for the new id |
| Model profiles: active revision per profile (model, env, secrets), the Agent's active profile, per-Shadow model selection | Secrets decrypted with the old key, saved through `AgentProfileStore` |
| Plugin configurations and their secrets | Through `AgentPluginStore` |

Secrets are bound to their row ids (AES-GCM associated data), so they are
never copied as ciphertext. The old master key comes from
`--from-key-file` and defaults to the new Service's own key. Not imported:
everything listed above as not carried over, deleted Agents and Shadows, retired
bot bindings, earlier profile revisions, Worker admission and Shadow routing
(the Worker binds again). The command prints what it created; it refuses a
database that already has Agents.

Feishu bots keep their app, so after import the same people writing to the same
bots become new users of the new Agent; the owner links their Feishu identity
again with `#link`.

## Delivery

One schema change in the new baseline, then four steps, each tested on a fresh
database:

1. **Accounts and Agent users in the schema**: `accounts`; `users.agent_id`,
   `account_id`, `kind` `shadow`; column renames; identity links per Agent.
2. **Runtime**: scoped identity resolution, owner user created with the Agent,
   one owner helper replacing the 11 comparisons, Dashboard account → user
   resolution, platform and Agent routes split.
3. **Agent user management**: Users page list/remove/block/rename, ingress
   refusal for `blocked`, account deletion on a platform admin page.
4. **Owner Feishu binding** (`#link`, Dashboard confirmation, merge, unlink).

Then `import-config`, used to rebuild the local 8090 database from the current
one and to verify a real Feishu and Dashboard conversation.

Tests: the same `union_id` sender in two Agents is two users with separate
names, memory and status; the owner of two Agents has one user in each; `#link`
merges a sender into the owner user and is refused in groups, across Agents and
for bots; import recreates Agents, bots and models from a database seeded with
the previous baseline, and the imported secrets decrypt.

## Decisions (2026-11-17)

1. Naming: `accounts` + `users`, with the naming rules above.
2. Collaborators (non-owner accounts in an Agent's Dashboard): not in this
   round; `users.account_id` leaves room for them.
3. Owner Feishu binding is in this round.
4. No in-place upgrade; configuration import instead.
