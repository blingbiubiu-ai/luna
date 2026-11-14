import { Hono } from "hono";

import { getKernel } from "./kernel";

const startTime = Date.now();

/** Read-only runtime observability. Test injection stays in the test harness. */
export const runtimeRoutes = new Hono().get("/status", (c) => {
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  return c.json({
    status: "ok",
    uptime,
    channels: getKernel().channelStatuses(),
  });
});
