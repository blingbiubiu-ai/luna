# End-To-End Flows

## Feishu Image To Report Artifact

```mermaid
sequenceDiagram
  participant Feishu
  participant Adapter as Channel Adapter
  participant Session as Session Runtime
  participant Main as Main Runner
  participant Task as Task Runner
  participant Artifacts as Artifact Registry
  participant Card as Status Card

  Feishu->>Adapter: image message
  Adapter->>Artifacts: register inbound image
  Adapter->>Session: normalized message with artifact:<id>
  Session->>Main: session context
  Main->>Session: luna task create
  Session->>Task: launch task with artifact input
  Task->>Artifacts: register generated report
  Artifacts-->>Task: artifact:<reportId>
  Task-->>Session: tasks report command (then completion marker)
  Session->>Card: terminal execution status
  Session->>Main: task_result event
  Main->>Session: luna messages send with artifact links
  Session-->>Feishu: user-facing reply with preview links
```

## Dashboard Attachment To Runner Prompt

```mermaid
sequenceDiagram
  participant Dashboard
  participant Service as Luna Service
  participant Artifacts as Artifact Registry
  participant Main as Main Runner

  Dashboard->>Service: message with attachment
  Service->>Artifacts: register attachment
  Artifacts-->>Service: artifact:<id>
  Service->>Service: persist message and timeline
  Service->>Main: prompt/context with artifact:<id>
  Main->>Service: task/session/message commands
  Main-->>Service: LUNA_NOTHING_TO_SEND
```

## Group Join Backfill To First Activation

```mermaid
sequenceDiagram
  participant Feishu as Feishu Group Event
  participant Adapter as Feishu Channel Adapter
  participant Backfill as Group Join Backfill
  participant Session as Session Store
  participant Timeline as Timeline/Context
  participant Main as Main Runner

  Feishu->>Adapter: bot added to group
  Adapter->>Backfill: backfillOnBotAddedToGroup
  Backfill->>Feishu: list recent group history
  Backfill->>Feishu: list referenced thread history when needed
  Backfill->>Session: persist messages only
  Session->>Timeline: append root or thread timeline entries
  Note over Backfill,Timeline: no inbox enqueue, no turn, no runner call
  Feishu->>Adapter: later explicit @Luna message
  Adapter->>Timeline: resolve candidate context from normal timeline pool
  Timeline->>Main: launchSeed/deltaContext from selected packs
  Main->>Session: luna messages send
  Session-->>Adapter: deliver reply
```

## Plugin Diagnosis Dump To Share Link

```mermaid
sequenceDiagram
  participant Runner as Task Runner
  participant CLI as luna diagnosis
  participant Service as Operation API
  participant Plugin as Diagnosis Plugin
  participant Artifacts as Artifact Registry
  participant Surface as Dashboard or Feishu

  Runner->>CLI: diagnosis query
  CLI->>Service: POST /api/plugins/commands/resolve-and-invoke
  Service->>Service: resolve installed plugin command
  Service->>Service: authenticate and evaluate operation grant
  Service->>Plugin: invoke diagnosis operation
  Plugin->>Plugin: execute upstream operation
  Plugin->>Artifacts: register dump and raw response
  Artifacts-->>CLI: artifact metadata
  CLI-->>Runner: result with artifact refs
  Runner->>Artifacts: register final report
  Artifacts-->>Surface: signed preview/content links
```

## Markdown Report With Embedded Artifact

```mermaid
sequenceDiagram
  participant Page as Preview Page
  participant API as Preview Data API
  participant Artifacts as Artifact Registry
  participant Nested as Nested Artifact

  Page->>API: GET /api/artifacts/:id/preview
  API->>Artifacts: read report artifact
  API->>Nested: resolve artifact refs in markdown
  Nested-->>API: signed content or preview URL
  API-->>Page: markdown content with projected URLs
  Page->>Page: render markdown
```

## Runner Local File To User Link

```mermaid
sequenceDiagram
  participant Runner as Main or Work Runner
  participant CLI as luna artifacts register
  participant Artifacts as Artifact Registry
  participant Renderer as Channel Renderer

  Runner->>Runner: write workspace/final-report.md
  Runner->>CLI: register file
  CLI->>Artifacts: upload content
  Artifacts-->>CLI: artifact:<id>
  CLI-->>Runner: artifact ref
  Runner->>Renderer: message command containing artifact ref
  Renderer->>Artifacts: request signed preview link
  Renderer-->>Renderer: render clickable user link
```
