import { expect, test } from "bun:test";
import { openExecutionDatabase } from "@luna/execution-store";
import { WorkerContextStore } from "@luna/worker/context-store";

test("Worker keeps context scope independently of Executor creation order", () => {
  const db = openExecutionDatabase(":memory:");
  try {
    const store = new WorkerContextStore(db);
    const first = store.ensure("first", "session:first");
    const second = store.ensure("second", "session:second");
    expect(second.contextId).not.toBe(first.contextId);
    const recovered = new WorkerContextStore(db);
    expect(recovered.ensure("second", "session:second")).toEqual(second);
    expect(recovered.ensure("first", "session:first")).toEqual(first);
    expect(() => recovered.ensure("first", "other_scope")).toThrow("context_scope_conflict");
  } finally { db.close(); }
});
