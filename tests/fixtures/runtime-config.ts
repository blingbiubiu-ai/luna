import { createServer } from "node:net";
import { join } from "node:path";
import { RuntimeConfig } from "../../src/runtime/config";
import { writePrivateJson } from "@luna/execution-store";

/** Real embedded scheduler configuration for Service boot tests without a Worker. */
export async function writeRuntimeFixture(home: string): Promise<void> {
  const server = createServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>(resolve => server.close(() => resolve()));
  const dataRoot = join(home, "runtime");
  writePrivateJson(join(dataRoot, "runtime.json"), RuntimeConfig.parse({
    runtimeId: "test-runtime", serviceId: "service", dataRoot, port,
    serviceToken: "s".repeat(43), adminToken: "a".repeat(43), homeWorkerId: "worker",

  }));
}
