# Operations And Debugging

## Service Process

Use the CLI to inspect and manage the local Luna agent service:

```bash
luna service status
luna service stop
luna service start
```

When debugging stale behavior, first confirm which service process is running and which `LUNA_HOME` it uses. Multiple old local services can make Dashboard or Feishu appear to run outdated code.

For runner, channel, or Feishu-adjacent debugging, prefer starting the local service from the current build in a persistent terminal:

```bash
set -a
source ~/.luna/.env
set +a
bun dist/luna-service.js start --foreground --port 8090
```

Use `set -a` when sourcing `.env` files that contain plain `KEY=value` lines. Without it, newly defined shell variables may not be exported into the Luna process, and sandbox job env collection will not see them.

Confirm the running process and local HTTP response:

```bash
lsof -nP -iTCP:8090 -sTCP:LISTEN
curl -sS -I http://127.0.0.1:8090 | head
```

## Common IDs

Most investigations need a small set of IDs:

- session id: the conversation view.
- task id: the durable work unit.
- task run id: a specific runner attempt.
- timeline entry id: the session-visible message/reference/event unit.
- message id: the provider-neutral true message fact.
- artifact id: the durable resource reference.
- runner decision id: the persisted Main Runner decision.

Use timeline entry id when asking "which message entered the runner?" Use message id when checking the true source message.

## Message Flow Debugging

Production HTTP exposes read-only Runtime status at `/api/runtime/status` to signed-in Dashboard users. Channel connection status belongs to Agents: `?agentId=` returns that Agent's channels to its owner; without it only a platform administrator sees all channels.
The former `/api/runtime/test/inject-message` route is removed: callers must not
synthesize verified provider identities or substitute channel adapters through
an authenticated HTTP endpoint. Test code exercises ingress through the existing
in-process harness; these helpers are not exposed as HTTP routes.

For deployment acceptance, send a real message from the intended Feishu account
to the configured bot and inspect its reply, the Dashboard session timeline and
Worker logs. A synthetic outbound capture cannot prove provider delivery.
Use the Agent's Dashboard settings to inspect the selected model and connection
status. Runtime status contains service uptime and channel status, not an Agent
model or execution profile.

Before debugging the full chain, verify the service and image:

```bash
curl -fsS http://127.0.0.1:8090/api/health
luna service status
docker ps -a --format '{{.Names}} {{.Image}} {{.Status}}'
docker run --rm --entrypoint /bin/bash luna-runner:latest \
  -c 'command -v claude; command -v codex'
```

Inspect masked configuration through the Dashboard. Do not print credentials,
full environment files or encrypted secret rows while collecting diagnostics.

## Broken Dashboard Images

For a broken Dashboard image, check:

1. the message or report contains `artifact:<id>` or a signed content URL.
2. the artifact exists and is active.
3. the signed URL has not expired.
4. `/api/artifacts/:id/content` returns the image bytes.
5. `/api/artifacts/:id/preview` returns preview data when the user opens a preview page.
6. Dashboard Markdown rendering preserved the link or image URL.

Useful search:

```bash
rg -n "artifact:<id>|/artifacts/.*/preview|/api/artifacts/.*/content" docs src tests
```

Replace `<id>` with the artifact id when searching a specific case.

## Missing Feishu Images Or Files

For a Feishu reply that should include an image, file, or report link, check:

1. Task Runner registered the generated file with `luna artifacts register`.
2. Task artifacts include the expected artifact id and MIME type.
3. Notification code appended task artifact links independently from the LLM body.
4. The channel renderer used content URLs for actual image bytes and preview URLs for clickable links.
5. The status/result card rendered links as links, not literal Markdown text.

## Signed Link Expiry

Signed artifact links expire after 2 hours. Expired anonymous links should fail. Authenticated related users should still be able to access their related artifacts through normal authorization.

When debugging expiry:

- compare the `expires` query value with current time.
- request a fresh signed link as an authorized user.
- confirm the artifact access policy allows the requester after expiry.

## Runner Artifact Registration

Runner output should contain `artifact:<id>` or a signed preview/content link, not a raw workspace path.

Check the prompt contract and runner output when users see text such as
`workspace/final-report.md` or host absolute paths. The intended runner flow is:

```bash
luna artifacts register workspace/final-report.md --json
```

Then the runner should reference the returned `artifact:<id>`.

## Diagnosis Output

Diagnosis operations are plugin operation invocations and can produce large dumps. Those outputs should become artifacts and appear in Dashboard/Feishu as links.

For TEA behavior queries, inspect:

- the request id and operation id.
- the operation invocation audit record and caller decision.
- the dump artifact id.
- the task timeline event that recorded plugin evidence, when the invocation came from a task.
- the final report artifact, if the task generated one.

## Verification Commands

Core checks:

```bash
bun run typecheck
bun test tests/cli/cli.test.ts
bun test tests/runtime/unified-api-routes.test.ts
```

Documentation-specific checks:

```bash
rg -n "artifact:<id>|/artifacts/.*/preview|/api/artifacts/.*/content" docs src tests
git diff --check
```
