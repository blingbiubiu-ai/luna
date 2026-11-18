# CLI, MCP, And Workspace

## CLI Responsibility

`luna` CLI is the stable local interface for developers, runners, and automation to access Luna Service. It should not bypass Service to read or write internal databases directly.

CLI owns:

- login and token management.
- artifact register, materialize, download, and cat.
- plugin-contributed operation commands such as `luna diagnosis ...`.
- knowledge workspace reads and writes.
- Agent memory reads and writes for the active invocation (`luna memory`, see [Agent memory](agent-memory.md)).
- MCP bridge.
- local Service management through `luna service ...` and Worker management through `luna worker ...`.

Deployment namespaces forward to independent component processes; they do not
bundle Service or Worker implementation into the client. Both stdin interaction
and foreground signals are forwarded. Legacy `luna-service` and `luna-worker`
executables remain supported, including existing daemon scripts. Business
commands continue to use the Service API. See
[execution topology](execution-runtime-foundation.md) for component resolution
and standalone installation requirements.

The Service entrypoint dispatches lifecycle and database commands directly to
its handlers. It has no nested `agent` command router or JSON response rewriting
layer. Lifecycle help is handled before side effects, including foreground
startup and database reset. The internal daemon identifier remains `agent` so
existing PID/log locations and process management remain stable.

## Artifact Register

`luna artifacts register <path>` registers a local file as a Service-managed artifact and returns `artifact:<id>`.

After a runner creates a user-visible file, it should register the file before referencing it in a reply. Service validates registration through runner token scope:

- Main Runner can register only within its session scope.
- Task Runner can register only within its task scope.
- A runner cannot spoof arbitrary session/task ownership.

## Artifact Materialize

`luna artifacts materialize artifact:<id>` returns a local path readable by the current runtime.

Materialize semantics:

- If a local cache exists and its hash/manifest is valid, return the cached path.
- If the cache is absent or invalid, download content through Service.
- Authorization depends on the current token, runner scope, or user permission.
- This converts a durable artifact reference into a current-runtime file. It is not an arbitrary file-read interface.

## HOME And LUNA_HOME

`HOME` is the OS-provided home for the current process. It is determined by the shell, service manager, or sandbox environment.

`LUNA_HOME` is Luna's runtime/config/data root. It usually contains:

- `config.yaml`
- `.env`
- session runner roots
- task runner roots
- artifact cache or managed storage
- runtime logs and state files

Configuration precedence should remain: built-in defaults < `config.yaml` < `.env` < current process environment < CLI arguments.

## Runner Workspace

Runner cwd is resolved on the selected Worker as `<runnerRootBase>/<runner-id>`, where the configurable
`runnerRootBase` defaults to `$LUNA_WORKER_HOME/runner-home/runners`. Session ids and task ids share
this flat runner-id namespace. `workspace/` is the runner-private root for working files,
intermediate outputs, reports, and logs.

Example:

```text
<runnerRootBase>/                  # default: $LUNA_WORKER_HOME/runner-home/runners
  <runner-id>/                     # <session-id> or <task-id>
    AGENTS.md
    CLAUDE.md
    workspace/                     # runner-private outputs
    ipc/input/
```

Service materializes merged skills at `$LUNA_HOME/.runner-skills` and publishes them with commands, Memory and `.runner_prompt` templates. Registered Workers synchronize these into their existing local directories. Worker renders `AGENTS.md`/`CLAUDE.md` using the role template and Worker-local container paths; Service supplies the dynamic context JSON during preparation. The runner
container bind-mounts that directory read-only over the agent-native
`.agents/skills` and `.claude/skills` mount points; Luna does not create a bare
`skills` symlink.

Workspace-local paths should become artifacts before user-facing replies. When Main Runner and Task Runner execute in containers, host paths are not naturally reachable; `artifact:<id>` and materialize are the long-term protocol.

## Runner Sandbox Environment

Main Runner and Task Runner always run inside `luna-runner:latest` containers. The `luna` command in the container runs the CLI the Worker mounts at `/opt/luna-runtime/current/luna-client.js` (falling back to the image's `/app/luna-cli/cli.js` under older Workers); runner tools should still call Service through CLI/API rather than reading runtime databases or host paths directly.

Environment is injected in two stages:

- Container-start env is low-sensitivity and static, such as `IS_SANDBOX`, `HOME=<runnerRootPath>`, `LUNA_RUNNER_HOME=<runnerRootPath>`, and the Runner home.
- Job env is dynamic and includes `LUNA_SERVICE_URL`, `LUNA_ACCESS_TOKEN`, session/task/run identifiers, artifact allowlists, requested identity metadata, and model provider variables such as `ANTHROPIC_BASE_URL`, `OPENAI_API_KEY`.

Runtime passes Job credentials to Executor over HTTP. Executor prepares the Runner environment and passes input to the subprocess using stdio inside the container. The Luna CLI reads the current Job credential when it calls Service.

## MCP

Luna Service exposes an HTTP MCP endpoint. Local MCP clients that support only stdio transport can use the CLI bridge.

MCP tools mirror Service/workspace APIs and do not accept user-id override. Caller identity comes from the current access token or runner token.

## Knowledge Workspace

Knowledge workspace is a controlled workspace. Runners, CLI, and MCP access it through Luna Service rather than directly reading arbitrary local knowledge files.

Common commands:

```bash
luna workspace knowledge glob "wiki/**/*.md"
luna workspace knowledge grep "keyword" --glob "wiki/**/*.md"
luna workspace knowledge read wiki/index.md
luna workspace knowledge write wiki/domains/example.md --body-file /tmp/example.md
luna workspace knowledge git-commit --message "docs: update example"
```

Writes are explicit two-step operations: `write` updates workspace files, and `git-commit` commits the changes.

## Primary Code Paths

- `apps/cli/src/main.ts`
- `apps/cli/src/commands/artifacts.ts`
- `apps/cli/src/commands/workspace.ts`
- `src/cli/commands/mcp.ts`
- `src/runners/runner-root-layout.ts`
- `src/shared/config/paths.ts`
- `src/mcp/knowledge-server.ts`
- `src/workspace/repository.ts`
