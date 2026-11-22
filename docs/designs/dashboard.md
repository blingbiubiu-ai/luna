# Dashboard

## Responsibility Boundary

Dashboard is the debugging and operations UI for Luna runtime facts. It displays sessions, tasks, timelines, runner decisions, prompts, status cards, result cards, users, grants, knowledge workspace state, and artifacts.

Dashboard must use Luna Service APIs. It must not read the database or Service-private artifact storage directly.

## Pages And APIs

Dashboard pages consume projections from Service routes:

- session routes for timeline, context, and session state.
- task routes for task detail, runs, status, source context, and artifacts.
- artifact routes for metadata, content, signed URLs, and preview data.
- user/group routes for identity and authorization rule administration; no standalone capability/operation management page.

Projection code should prepare stable UI data while keeping authorization and signing in Service.

## Platform Shell

Every page shows a platform rail at the far left: the Luna brand, Agents (`/`; also
active inside any Agent), 平台 → 插件 only when `GET /api/auth/me` reports
`isPlatformAdmin`, and the account menu at the bottom. There is no Agent list page:
`/` opens the first Agent the user can access, or, when there is none, offers 新建
Agent. Agent pages (`/agent/*`, Agent router) add a collapsible Agent sidebar beside
the rail, headed by an Agent switcher (other Agents and 新建 Agent) and grouped into
运行, 工作空间, 用户与权限 and 运行环境. `/platform/*` pages show only the rail.
The rail stays mounted across all pages and the Agent router and platform pages share
one browser history, so rail and sidebar navigation switch content without a page load. Platform pages
check the administrator flag and the platform APIs enforce that authority themselves.

## Plugins View

Plugin installation is a platform page: 插件管理 (`/platform/plugins`, detail at
`/platform/plugins/:pluginId`) for platform administrators. Inside an Agent, the
Plugins page only enables and configures already-installed plugins.

The platform plugin page presents a searchable list of compact plugin cards and an overview
of available, running, and pending-restart counts. Running state comes from
installation `activeState`; the enable switch represents `desiredState`. A
pending change never implies that the running plugin has already changed.

Version actions and detail links remain available on each card. Package paths and
version history are shown on the detail page. Mutations disable conflicting actions
while in flight, display failures inline, and reload installation state after success.
The service remains the source of truth for installation and restart semantics.

## Session View

The session workspace is a two-column Feishu-style chat workbench (collapsing into separate list and detail screens below `760px`):

- **Left conversation list**: mixes group chats, direct chats, and local Dashboard sessions in one activity-ordered stream with filter tabs (`全部 / 群聊 / 私聊 / 旁听中`), search, and optional Historical Bindings toggle when retired bindings exist. Main topic sessions (`parentSessionId`) nest inline under their parent group chat: collapsed groups summarize topic and attention counts, while expanded groups rank active/waiting/failed topics ahead of idle ones (`3` shown initially, `+10` per expansion, keeping the currently open topic visible).
- **Right conversation detail**: displays the group/peer avatar, member count, topic breadcrumb back to the parent group, Shadow/channel/Worker metadata, per-group ambient listening switch (`旁听` / `旁听整个群`), Open TUI link, and a `⋯` menu (`复制会话 ID`, `查看 Runner 上下文`, and secondary-confirmed `删除会话`). Messages render as Feishu-style bubbles with inline quote blocks (`replyQuote`), dashed ambient-listening batch cards, rich status/final-answer cards, hover timestamps, and hover debug copy controls for timeline entry/message IDs and turn Main Runner prompts. The composer sends on `Enter` and inserts a newline on `Shift+Enter`.

The session timeline loads the newest page from Service on entry, then requests older pages with a cursor as the operator scrolls up. Pages preserve chronological order and keep turn groups intact. The dashboard preserves the visible position when prepending older entries.

Session view should preserve the distinction between:

- true messages that occurred in the session surface.
- reference entries projected from another surface.
- internal event entries such as conversation-control interruptions.
- artifact links or previews attached to message content.

Session timeline rendering should also expose message provenance that changes operator understanding, for example:

- history-import / backfill markers for imported group history
- system-style rendering for conversation-control events
- thread session anchors and root-session references

These distinctions matter for debugging because they explain why a message was visible to Runtime without implying that it was a live inbound event in that session.

## Task View

Task views show durable work state across two coordinated screens:

- **Task list (`/agent/:agentId/tasks`)**: displays live queue pulse status, clickable status summary tiles, segmented status tabs (`All / Running / Waiting / Completed / Failed / Cancelled`, deriving `Waiting` when `taskContext.pendingQuestions` is non-empty while idle), type/priority/Shadow filters, and a toggle between grouped focus/archive view (`Active & needs attention` ahead of `Recently finished`) and flat activity-stream view. Each row surfaces linked session provenance, latest run/runner/duration, artifact counts, participant avatars, and `Open TUI` / detail shortcuts; selecting a row on wide screens opens a right-hand quick-peek inspector without leaving the list.
- **Task detail (`/agent/:agentId/tasks/:taskId`)**: organizes durable state into localized tabs (`Timeline`, `Report`, `Runs`, `Artifacts`, and `Context`) with top-level `Open TUI`, copyable Task ID, contextual waiting/error callouts, and `Operation Trace` summaries:
  - task status, title, summary, context, and subscriptions.
  - task runs, materialized prompts, runner status, and terminal state.
  - source context packs and task timeline events.
  - artifact outputs, including reports, patches, logs, images, files, and previews.

Task artifacts should be listed independently from the LLM text body. Status cards may include direct LLM output, but complete report links should come from recorded task artifacts when they exist.

## Artifact Preview

Artifact preview uses a separated web/API design:

- `/artifacts/:id/preview` is a web route that renders the preview UI.
- `/api/artifacts/:id/preview` returns preview data.
- `/api/artifacts/:id/content` returns raw original content.

The preview page reads `id`, `expires`, and `sig` from the browser URL, calls the preview API with those values, then renders by `renderMode`.

Images embedded in Dashboard should use content URLs, not preview page URLs. Links that open a viewer should use preview URLs.

## Markdown Rendering

Dashboard Markdown rendering should preserve relative artifact routes such as `/artifacts/...` as clickable links.

For preview data:

- markdown content is rendered by the frontend.
- nested image references should point to signed content URLs.
- nested artifact links should point to signed preview URLs.
- unsupported or unauthorized nested refs remain visible as literal text.

The service returns preview data and projected links; the frontend owns Markdown-to-HTML rendering and viewer layout.

## Status Card Display

Status cards should display useful runner/LLM output and append deterministic artifact links when task artifacts exist.

Rules:

- Direct LLM output remains the status card body.
- Short reports can be summarized inline.
- Large reports should be linked as artifacts instead of copied into status cards.
- If a task has no report artifact, the status card still works with direct output.
- Artifact links should render as real links, not literal Markdown strings.

## Primary Code Paths

- `src/server/routes/sessions.ts`
- `src/server/routes/tasks.ts`
- `src/server/routes/artifacts.ts`
- `src/dashboard-api/sessions.ts`
- `src/dashboard-api/tasks.ts`
- `src/dashboard-api/local-paths.ts`
- `apps/dashboard/src/app/sessions/session-detail-view.tsx`
- `apps/dashboard/src/app/tasks/index.tsx`
- `apps/dashboard/src/app/tasks/task-detail-view.tsx`
- `apps/dashboard/src/artifact-preview-main.tsx`

## Removed usage dashboard

The dashboard no longer exposes `/agent/usage`, its sidebar entry, or either
`/api/usage/claude` or `/api/agent/usage/claude`. The dedicated Claude OAuth usage
lookup and macOS Keychain credential reader have been removed. Runner token
accounting and shared model-context UI components are independent of this page.

Knowledge search debounces input for 300 ms and waits for IME composition to finish.
The search form supports Enter and the search button. File browsing loads one
directory at a time on expansion. Filename and content search run on Service,
independent of expanded directories, and return bounded results separately; the
browser no longer downloads a recursive glob to filter filenames. Pending, empty, and failed
requests have explicit feedback; failed queries can be retried by submitting again.

The dashboard pages, shared forms and dialogs, and standalone artifact preview use a React locale context with
English and Simplified Chinese dictionaries. A header language menu persists the
choice in `luna-ui-language`; first use follows the browser language. Translation
applies to UI labels only, preserving document contents, paths, IDs, and raw errors.
The service-rendered login page (`/login`) shares the same language preference and provides its own selector. When Feishu OAuth is configured and enabled, `/login` promotes the primary Feishu Login button (`/api/auth/feishu/start`) and keeps local access-token login inside a collapsible fallback disclosure; when Feishu OAuth is not yet configured, `/login` leads with the access-token form and renders a secondary Feishu Login entry that guides the operator to configure Feishu credentials in `/platform/settings`. Platform administrators and the built-in Super Administrator (`local-dashboard-user`) manage platform-wide runtime settings on `/platform/settings` without restarting Service: general access & timezone (`general.publicBaseUrl` shared by Feishu OAuth callbacks and signed Feishu artifact preview links, plus `general.timezone`), Feishu OAuth credentials (`App ID`, encrypted `App Secret`, `feishuHost`, and copyable Redirect URI), plugin marketplace Git source (`marketplace.gitUrl` and `branch`), execution & retry limits (`execution.containerTimeoutMs`, `execution.taskTimeoutMs`, and `maxTransientRetries`), memory maintenance intervals & quotas (`memory.*`), Feishu card step cap & `union_id` developer mappings (`messaging.maxVisibleSteps` and `feishuDevelopers`), and orphan cleanup, along with the administrator entry to `/platform/accounts` for viewing platform accounts, granting/revoking Feishu platform administrators, and disabling or deleting accounts.
Dynamic presentation labels and counts use the locale context; authorization paths,
API payloads, user-entered names, models, document contents and diagnostics remain unchanged.

Workspace grep skips binary assets and files larger than 2 MiB, scans at most 32 MiB
of text per request, and returns at most 500 matches with bounded line previews.
Responses expose skipped-file counts and result truncation so the UI does not imply
an exhaustive search. These limits prevent archived media from blocking the service.

The Dashboard application lives in `apps/dashboard` as workspace package
`@luna/dashboard`. Build and typecheck it with `bun run --cwd apps/dashboard
build` and `bun run --cwd apps/dashboard typecheck`. Root builds include both
commands; browser sources use the Dashboard tsconfig rather than the backend
compiler scope. Service hosts `apps/dashboard/dist` at the existing `/agent`
routes. Release packages and systemd use the same static asset location.

## Workers

The Agent owner manages the default Dashboard identity and digital Shadows at `/agent/<agentId>/settings/channels`. Each
Shadow (the body first) is one card: name, bot binding and a "⋯" menu (edit settings, reset system
disk, disable or resume, delete), then its runtime environment: state (running, stopped or not
created), the root switch, Worker, resources, whether the image is current, active tasks, and
Terminal / Desktop / Root terminal buttons. Opening a console narrows the cards to a compact
column and shows the consoles as tabs beside it; a stopped or not-yet-created container is
provisioned first. There is no separate Containers page; `/settings/containers` redirects here. The creation form accepts a Shadow name and optional Feishu bot settings. If the bot cannot be bound after the Shadow is created, the form can retry the binding on the same Shadow.

Each Shadow card opens an editor with the bot settings and the Shadow’s lifecycle actions. Removing the bot ends its binding and keeps the Shadow and its history. Deleting a Shadow (or
Agent) warns that its Worker data — container, HOME (login state, git/ssh, browser data,
files), installed software, resource snapshots and `/data` volume — is removed for good
while history stays, and requires typing the name to confirm. A saved bot configuration can be selected once its prior binding has been removed or its Shadow has been deleted.

At `/agent/<agentId>/settings/workers`, the Agent owner can create a pairing code for that Agent, and see assigned Workers. The Worker CLI redeems the code and the Service assigns the Worker to that Agent. To assign an existing private Worker to another Agent, get a new code from that Agent and run bind again on the same Worker. The owner can remove an assignment from that Agent.

The Agent owner can pause or resume an assigned Worker from the Agent’s Workers page. The action changes only this Agent’s assignment; other Agents using the same Worker keep admitting work.


Task timeline uses `/api/tasks/:id/timeline/page`, polling loaded pages and loading older records on demand. Tool status updates one row and public text can be inspected in full. See [Progress notifications](progress-notifications.md).
