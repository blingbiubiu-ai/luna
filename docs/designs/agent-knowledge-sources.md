# Agent knowledge Git sources

Each Agent owns an independent Git repository at
`<serviceHome>/agents/<agentId>/knowledge`. The repository root is the knowledge
workspace root. `wiki/`, `notes/`, `archive/` and `policies/` remain the permitted
read/write roots. A repository with a wrapping `knowledge/` directory must be
restructured before initialization. Git history is preserved by a full,
single-branch clone; no submodules are initialized.

The Agent settings page has a knowledge section with a Git address and optional
branch. Source management uses Dashboard authentication and Agent ownership plus
active-Agent access; Runner grants and platform administration do not implicitly
permit source management. Its API is:

- `GET /api/agents/:agentId/knowledge/source`: source and last operation state.
- `PUT /api/agents/:agentId/knowledge/source`: configure and start initialization.
- `POST /api/agents/:agentId/knowledge/source/sync`: retry or synchronize.

Source metadata is stored atomically with owner-only file permissions in
`<serviceHome>/agents/<agentId>/knowledge-source.json`, outside the repository and
Runner-readable workspace. It contains URL, resolved branch, initialized flag,
status, commit, update time and a sanitized error. It is independent of the general
settings JSON, so auto-saving message settings cannot overwrite the source.
Service backups must include both this metadata and the Agent's repository.

The Service starts asynchronous Git operations and returns 202. Dashboard polls
while initializing/syncing and refreshes the Agent's knowledge caches on success.
Initialization clones to a fresh sibling staging directory, validates the layout
and Git root, then replaces only an empty, uncommitted Agent repository. Existing
files or commits block initialization. Configured initialized sources cannot be
replaced through this API. A failed initial clone preserves the empty workspace
and can be retried with a corrected address or branch.

Sync requires the configured local branch and origin and a clean entire working
tree. It fetches the configured branch and merges with `--ff-only`. Local edits
and divergent commits stop the operation; there is no automatic push, periodic
sync, reset or conflict resolution. The last successful repository stays available
after a failed Git update. During operations the shared per-Agent operation gate
rejects HTTP/MCP workspace accesses with 409, preventing API writes racing Git.
The deployment model is one Service process per Service home; the in-process gate
is not a lock for multiple Service processes or external filesystem writers.

HTTPS, HTTP and SSH/scp addresses are supported; local filesystem and external
command transports and URL-embedded credentials are rejected. Git runs through
argument arrays with timeouts, terminal prompting disabled, inherited `GIT_*`
variables removed and hooks/file/ext transports disabled. Private repository
credentials come from the Service account's existing Git credential helper or
SSH credentials. If `<serviceHome>/.gitconfig` exists, Git uses it as the trusted
global config even when the system account has no login home. Its configured
`core.sshCommand` is preserved and SSH is forced into batch mode; this feature does not store new credentials. Raw Git diagnostics
are not persisted. Knowledge file confinement and Agent authorization continue to
apply after cloning.

After a Service restart, a completed clone that was activated before its metadata
write is recovered by checking the isolated Git root, branch, origin and HEAD.
Other running operation metadata becomes an interrupted error that can be retried.
Completed initialization is never implicitly repeated at Service startup. Staging directories left by process termination may
need administrator cleanup.

Primary code paths: `src/agents/agent-knowledge-source.ts`,
`src/workspace/knowledge-storage.ts`,
`src/server/routes/agent-knowledge-source.ts`,
`extensions/workspace/knowledge/definition.ts`, and
`apps/dashboard/src/app/settings/knowledge-source.tsx`.

## Directory browsing and search

Dashboard discovers the knowledge root with
`GET /api/workspaces/knowledge/directory?agentId=<id>&path=`. Each response lists
only immediate children, with a `type` discriminator for files and directories.
Root discovery exposes existing permitted roots; hidden metadata, special files,
all symlinks are excluded from directory listings. Traversal/disallowed directory
paths fail with 400; nonexistent/non-directory paths fail with 404. The existing
Agent ownership / business read-grant boundary applies before enumeration.

The directory tree requests a child's listing only when its folder is expanded.
Each directory has an Agent/path-scoped query cache, loading/error feedback and
retry. Closing a branch unmounts its descendants and cancels outstanding requests.
Initial browsing does not request a recursive glob or any file body. Files are
read after selection. A large individual directory is still returned in one
response; this change does not add pagination.

Search remains independent of expanded directories. Once a nonempty search is
submitted/debounced, Dashboard asks the existing grep API to include filename
matches (`includeFileNames=true`). Filename results and content results are
separate and each capped at 500. Search results open files directly without
loading their parent directories. The existing content scan bounds and skip /
truncation reporting remain. The browser never downloads a complete glob to
perform filename search; recursive enumeration happens on Service only for an
explicit search. CLI/MCP glob and grep contracts retain their default behavior.
