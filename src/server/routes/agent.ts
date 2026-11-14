import { Hono } from "hono";

import { sessionsRoutes } from "./sessions";
import { skillsRoutes } from "./skills";
import { tasksRoutes } from "./tasks";

export const agentRoutes = new Hono()
  .route("/tasks", tasksRoutes)
  .route("/sessions", sessionsRoutes)
  .route("/skills", skillsRoutes);
