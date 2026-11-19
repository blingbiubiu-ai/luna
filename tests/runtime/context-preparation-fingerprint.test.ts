import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { ContextPreparationManager } from "../../src/runtime/context-preparation";

const scope = { agentId: "agent", shadowId: "shadow" };
const firstResources = { publicRevision: "a".repeat(64), agentToolsRevision: "b".repeat(64), digest: "d".repeat(64) };
type Resources = typeof firstResources;

/** A Worker that answers every preparation with the instruction hash it is told to. */
function harness(workerId = "worker", generation = 1) {
  let instructions = "first", resources: Resources = firstResources;
  const scheduler = {
    allowedWorkers: () => [workerId],
    jobs: { list: () => [] },
    isContextFileBusy: () => false,
    config: { homeWorkerId: workerId },
    placements: {
      boundWorkerId: () => workerId, context: () => ({ workerId }), applyRouting: () => {},
      bindContext: () => ({ workerId, generation }), require: () => {},
    },
    workers: { list: () => [], client: () => ({ call: async (_method: string, _path: string, body: { scope: unknown; resources: Resources }) => ({
      protocolVersion: 2, scope: body.scope, workerId, home: "/home/luna", cwd: "/home/luna/runners/context",
      instructionFingerprint: instructions, resources: body.resources, resourceRevision: body.resources.digest, env: {},
    }) }) },
  } as unknown as ConstructorParameters<typeof ContextPreparationManager>[1];
  const manager = new ContextPreparationManager(new Database(":memory:"), scheduler);
  let invocation = 0;
  return {
    setInstructions: (value: string) => { instructions = value; },
    setResources: (value: Resources) => { resources = value; },
    prepare: async () => (await manager.prepare({
      protocolVersion: 2, scope, resources, invocationId: `inv-${++invocation}`, contextId: "context", runnerId: "context",
      scopeKey: "session:context", runnerKind: "main",
    })).instructionFingerprint,
  };
}

test("new instruction content keeps the provider session; a different Worker does not", async () => {
  const worker = harness();
  const before = await worker.prepare();
  // A persona edit, a renamed Shadow or a rules update: Claude rereads CLAUDE.md, Codex resends AGENTS.md.
  worker.setInstructions("second");
  expect(await worker.prepare()).toBe(before);
  expect(await harness("other-worker").prepare()).not.toBe(before);
});

test("updated prompts, skills or tools keep the provider session; a moved placement does not", async () => {
  const worker = harness();
  const before = await worker.prepare();
  // A release that changes a built-in skill or prompt fragment publishes a new resource snapshot.
  worker.setResources({ publicRevision: "e".repeat(64), agentToolsRevision: "f".repeat(64), digest: "9".repeat(64) });
  worker.setInstructions("third");
  expect(await worker.prepare()).toBe(before);
  expect(await harness("worker", 2).prepare()).not.toBe(before);
});
