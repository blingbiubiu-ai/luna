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

The session list defaults to current conversations and keeps sessions from retired bot bindings available under Historical Bindings. Both views use the selected Shadow and search filter. Feishu group conversations and topics have distinct labels.

Session views show the conversation timeline, referenced messages, context packs, Main Runner decisions, prompts, actions, and related artifacts.

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

Task views show durable work state:

- task status, title, summary, context, and subscriptions.
- task runs, materialized prompts, runner status, and terminal state.
- source context packs and task timeline events.
- artifact outputs, including reports, images, files, and previews.

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
- `apps/dashboard/src/artifact-preview-main.tsx`

## Removed usage dashboard

The dashboard no longer exposes `/agent/usage`, its sidebar entry, or either
`/api/usage/claude` or `/api/agent/usage/claude`. The dedicated Claude OAuth usage
lookup and macOS Keychain credential reader have been removed. Runner token
accounting and shared model-context UI components are independent of this page.

Knowledge search debounces input for 300 ms and waits for IME composition to finish.
The search form supports Enter and the search button, with filename filtering and
workspace content grep results presented separately. Pending, empty, and failed
requests have explicit feedback; failed queries can be retried by submitting again.

The dashboard pages, shared forms and dialogs, and standalone artifact preview use a React locale context with
English and Simplified Chinese dictionaries. A header language menu persists the
choice in `luna-ui-language`; first use follows the browser language. Translation
applies to UI labels only, preserving document contents, paths, IDs, and raw errors.
The service-rendered login page shares the same language preference and provides its own selector.
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
