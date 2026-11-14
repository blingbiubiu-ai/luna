import {ResourceRouteAccess} from "../policy/resource-route-access";
import {AgentError} from "@/agents/agent-store";
import { deleteDashboardTask } from "@/dashboard-api/task-deletion";
import { loadDashboardUserRows } from "@/dashboard-api/user-display";
import { asc, desc, eq, sql } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";

import { ContextPackStore } from "@/context";
import type { DrizzleDB } from "@/data";
import { artifacts, channelIdentities, channelSurfaces, messages, sessionTurnEntries, sessionTimelineEntries, taskParticipants, taskRuns, taskSubscriptions, tasks, sessions, timelineEvents, channelUserBindings, users } from "@/data/schema";
import {
  buildDashboardTaskContextBundle,
  buildDashboardTasks,
  linkedSessionIdsForTask,
  toDashboardArtifact,
  toDashboardTaskRun,
  toDashboardTimelineEvent,
  type ArtifactRow,
  type DashboardTasksProjectionRows,
  type TaskRow,
  type TaskRunRow,
  type TimelineEventRow,
  type SessionTurnEntryRow,
  type TimelineMessageRow,
} from "@/dashboard-api/tasks";
import {
  type DashboardArtifactSigner,
  createDashboardArtifactSigner,
} from "@/dashboard-api/local-paths";
import {
  dashboardRequesterUserIdFromContext,
  lunaAccessTokenClaimsFromContext,
} from "@/server/auth";
import { selectDashboardContextBundleRows } from "./dashboard-context-selection";
import { getKernel } from "./kernel";

/**
 * Hono route collection for HTTP route DTO endpoints.
 */
export interface TasksRouteOptions {
  readonly db?: DrizzleDB;
}

export function createTasksRoutes(options: TasksRouteOptions = {}) {
  const routeDb = () => options.db ?? getKernel().database.db;
  const access=(c:Context)=>new ResourceRouteAccess(routeDb());
  const guard=async(c:Context,next:()=>Promise<void>)=>{
    if(c.req.param("id")==="dashboard"&&c.req.method==="POST")return next();
    if (c.req.method === "DELETE") access(c).requireDeletion(c, "task", c.req.param("id")!);
    else access(c).require(c, "task", c.req.param("id")!);
    await next();
  };
  return new Hono()
    .onError((error,c)=>{if(error instanceof AgentError)return c.json({code:error.code},error.status);if(error instanceof HTTPException)return error.res ?? c.json({message:error.message},error.status);throw error;})
    .use("/:id",guard).use("/:id/*",guard)
    .delete("/:id", c => { deleteDashboardTask(routeDb(), c.req.param("id")); return c.json({ status: "ok" }); })
    .get("/", (c) => {
      const db = routeDb();
      const artifactSigner = dashboardArtifactSignerForContext(c, db);
      const taskRows = selectDashboardTaskRows(db,access(c).listPredicate(c,"task"));
      return c.json(
        buildDashboardTasks(
          taskRows,
          selectDashboardTaskProjectionRows(db, taskRows, { artifactSigner }),
        ),
      );
    })
    .get("/:id", (c) => {
      const taskId = c.req.param("id");
      const db = routeDb();
      const artifactSigner = dashboardArtifactSignerForContext(c, db);
      const row = selectDashboardTaskRowById(db, taskId);
      if (!row) {
        throw new HTTPException(404, { message: `Task not found: ${taskId}` });
      }
      const [dashboardTask] = buildDashboardTasks(
        [row],
        selectDashboardTaskProjectionRows(db, [row], { artifactSigner }),
      );
      return c.json(dashboardTask);
    })
    .get("/:id/timeline", (c) => {
      const taskId = c.req.param("id");
      const db = routeDb();
      const artifactSigner = dashboardArtifactSignerForContext(c, db);
      assertTaskExists(db, taskId);
      const rows = selectDashboardTimelineEventRowsForTask(db, taskId);
      const sourceContextItems = new ContextPackStore(db).listTaskSourceItems();
      const subscriptionRows = db.select().from(taskSubscriptions).all();
      const sessionRows = db.select().from(sessions).all();
      const identityRows = db.select().from(channelIdentities).all();
      const userRows = loadDashboardUserRows(db);
      const channelUserBindingRows = db.select().from(channelUserBindings).all();
      const linkedSessionIds = linkedSessionIdsForTask(taskId, {
        sourceContextItems,
        subscriptionRows,
      });
      const taskSessionRows = sessionRows.filter((session) =>
        linkedSessionIds.has(session.id),
      );
      return c.json(
        rows.map((row) =>
          toDashboardTimelineEvent(row, {
            userRows,
            artifactSigner,
          }),
        ),
      );
    })
    .get("/:id/runs", (c) => {
      const taskId = c.req.param("id");
      const db = routeDb();
      const artifactSigner = dashboardArtifactSignerForContext(c, db);
      assertTaskExists(db, taskId);
      const rows = selectDashboardTaskRunRowsForTask(db, taskId);
      const contextBundleRows = selectDashboardContextBundleRows(db, "task", [
        taskId,
      ]);
      const contextBundle = buildDashboardTaskContextBundle(taskId, {
        contextBundleRows,
        messageRows: selectTimelineMessageRows(db),
        userRows: loadDashboardUserRows(db),
        artifactSigner,
      });
      return c.json(
        rows.map((row) =>
          toDashboardTaskRun(row, {
            contextPacks: contextBundle.contextPacks,
            seedRecords: contextBundle.seedRecords,
            artifactSigner,
          }),
        ),
      );
    })
    .get("/:id/artifacts", (c) => {
      const taskId = c.req.param("id");
      const db = routeDb();
      const artifactSigner = dashboardArtifactSignerForContext(c, db);
      assertTaskExists(db, taskId);
      const rows = selectDashboardArtifactRowsForTask(db, taskId);
      return c.json(rows.map((row) => toDashboardArtifact(row, { artifactSigner })));
    });
}

export const tasksRoutes = createTasksRoutes();

function dashboardArtifactSignerForContext(
  c: Context,
  db: DrizzleDB,
): DashboardArtifactSigner {
  return createDashboardArtifactSigner({
    db,
    requesterUserId: dashboardRequesterUserIdFromContext(c),
    accessTokenClaims: lunaAccessTokenClaimsFromContext(c),
  });
}

function assertTaskExists(db: DrizzleDB, taskId: string): void {
  const row = db
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get();
  if (!row) {
    throw new HTTPException(404, { message: `Task not found: ${taskId}` });
  }
}

function dashboardTaskSelection() {
  return {
    id: tasks.id,
    type: tasks.type,
    title: tasks.title,
    summary: tasks.summary,
    status: tasks.status,
    priority: tasks.priority,
    severity: tasks.severity,
    creator_user_id: tasks.creator_user_id,
    session_id: tasks.primary_session_id,
    primary_session_id: tasks.primary_session_id,
    source_message_id: tasks.source_message_id,
    source_entry_id: tasks.source_entry_id,
    context_json: sql<string>`${tasks.context_json}`,
    created_at: tasks.created_at,
    updated_at: tasks.updated_at,
    last_activity_at: tasks.last_activity_at,
  };
}

function selectDashboardTaskRows(db: DrizzleDB,predicate: ReturnType<ResourceRouteAccess["listPredicate"]>): TaskRow[] {
  return db
    .select(dashboardTaskSelection())
    .from(tasks)
    .where(predicate)
    .orderBy(desc(tasks.last_activity_at))
    .all();
}

function selectDashboardTaskRowById(
  db: DrizzleDB,
  taskId: string,
): TaskRow | undefined {
  return db
    .select(dashboardTaskSelection())
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get();
}


function selectDashboardTaskProjectionRows(
  db: DrizzleDB,
  taskRows: readonly TaskRow[],
  input: { readonly artifactSigner: DashboardArtifactSigner },
): DashboardTasksProjectionRows {
  return {
    participantRows: db
      .select()
      .from(taskParticipants)
      .orderBy(asc(taskParticipants.created_at))
      .all(),
    identityRows: db.select().from(channelIdentities).all(),
    userRows: loadDashboardUserRows(db),
    channelUserBindingRows: db.select().from(channelUserBindings).all(),
    sourceContextItems: new ContextPackStore(db).listTaskSourceItems(),
    subscriptionRows: db.select().from(taskSubscriptions).all(),
    sessionRows: db.select().from(sessions).all(),
    surfaceRows: db.select().from(channelSurfaces).all(),
    messageRows: selectTimelineMessageRows(db),
    turnEntryRows: selectDashboardSessionTurnEntryRows(db),
    runRows: selectDashboardTaskRunRows(db),
    timelineRows: selectDashboardTimelineEventRows(db),
    artifactRows: selectDashboardArtifactRows(db),
    contextBundleRows: selectDashboardContextBundleRows(
      db,
      "task",
      taskRows.map((row) => row.id),
    ),
    artifactSigner: input.artifactSigner,
  };
}
function dashboardTaskRunSelection() {
  return {
    id: taskRuns.id,
    task_id: taskRuns.task_id,
    run_index: taskRuns.run_index,
    status: taskRuns.status,
    reason: taskRuns.reason,
    input_snapshot: sql<string>`${taskRuns.input_snapshot}`,
    materialized_prompt: taskRuns.materialized_prompt,
    runner_type: taskRuns.runner_type,
    runner_context_id: taskRuns.runner_context_id,
    source_message_id: taskRuns.source_message_id,
    started_at: taskRuns.started_at,
    finished_at: taskRuns.finished_at,
    cancel_reason: taskRuns.cancel_reason,
    error: taskRuns.error,
    final_report_artifact_id: taskRuns.final_report_artifact_id,
  };
}

function selectDashboardTaskRunRows(db: DrizzleDB): TaskRunRow[] {
  return db
    .select(dashboardTaskRunSelection())
    .from(taskRuns)
    .orderBy(asc(taskRuns.task_id), asc(taskRuns.run_index))
    .all();
}

function selectDashboardTaskRunRowsForTask(
  db: DrizzleDB,
  taskId: string,
): TaskRunRow[] {
  return db
    .select(dashboardTaskRunSelection())
    .from(taskRuns)
    .where(eq(taskRuns.task_id, taskId))
    .orderBy(asc(taskRuns.run_index))
    .all();
}

function selectTimelineMessageRows(db: DrizzleDB): TimelineMessageRow[] {
  return db
    .select({ entry: sessionTimelineEntries, message: messages })
    .from(sessionTimelineEntries)
    .innerJoin(messages, eq(messages.id, sessionTimelineEntries.messageId))
    .orderBy(
      asc(messages.occurredAt),
      asc(sessionTimelineEntries.createdAt),
      asc(sessionTimelineEntries.id),
    )
    .all();
}

function selectDashboardSessionTurnEntryRows(
  db: DrizzleDB,
): SessionTurnEntryRow[] {
  return db
    .select()
    .from(sessionTurnEntries)
    .orderBy(asc(sessionTurnEntries.created_at), asc(sessionTurnEntries.id))
    .all();
}

function dashboardTimelineEventSelection() {
  return {
    id: timelineEvents.id,
    task_id: timelineEvents.task_id,
    session_id: timelineEvents.session_id,
    message_id: timelineEvents.message_id,
    actor_user_id: timelineEvents.actor_user_id,
    source_message_id: timelineEvents.source_message_id,
    type: timelineEvents.type,
    summary: timelineEvents.summary,
    data: sql<string | null>`${timelineEvents.data}`,
    visibility: timelineEvents.visibility,
    created_at: timelineEvents.created_at,
  };
}

function selectDashboardTimelineEventRows(db: DrizzleDB): TimelineEventRow[] {
  return db
    .select(dashboardTimelineEventSelection())
    .from(timelineEvents)
    .orderBy(asc(timelineEvents.created_at))
    .all();
}

function selectDashboardTimelineEventRowsForTask(
  db: DrizzleDB,
  taskId: string,
): TimelineEventRow[] {
  return db
    .select(dashboardTimelineEventSelection())
    .from(timelineEvents)
    .where(eq(timelineEvents.task_id, taskId))
    .orderBy(asc(timelineEvents.created_at))
    .all();
}

function dashboardArtifactSelection() {
  return {
    id: artifacts.id,
    task_id: artifacts.task_id,
    timeline_event_id: artifacts.timeline_event_id,
    type: artifacts.type,
    name: artifacts.name,
    mime_type: artifacts.mime_type,
    path: artifacts.path,
    content: artifacts.content,
    metadata: sql<string | null>`${artifacts.metadata}`,
    status: artifacts.status,
    retention_expires_at: artifacts.retention_expires_at,
    created_at: artifacts.created_at,
  };
}

function selectDashboardArtifactRows(db: DrizzleDB): ArtifactRow[] {
  return db
    .select(dashboardArtifactSelection())
    .from(artifacts)
    .orderBy(asc(artifacts.created_at))
    .all();
}

function selectDashboardArtifactRowsForTask(
  db: DrizzleDB,
  taskId: string,
): ArtifactRow[] {
  return db
    .select(dashboardArtifactSelection())
    .from(artifacts)
    .where(eq(artifacts.task_id, taskId))
    .orderBy(asc(artifacts.created_at))
    .all();
}
