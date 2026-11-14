import { and, eq } from "drizzle-orm";
import type { DrizzleDB } from "@/data";
import { artifacts } from "@/data/schema";
import { ArtifactRegistry } from "@/artifacts/artifact-registry";
import { artifactRef } from "@luna/service-client/artifact-ref";

/** Translate task timeline identities into active, downloadable references for Main. */
export function taskResultArtifactRefs(db: DrizzleDB, taskId: string, ids: readonly string[]): string[] {
  const registry = new ArtifactRegistry(db);
  const refs = new Set<string>();
  for (const id of ids) {
    const row = db.select().from(artifacts).where(and(eq(artifacts.id, id), eq(artifacts.task_id, taskId), eq(artifacts.status, "active"))).get();
    const metadata = row?.metadata;
    const managedId = metadata && typeof metadata === "object" && "managedArtifactId" in metadata ? metadata.managedArtifactId : undefined;
    if (typeof managedId !== "string") continue;
    const managed = registry.getActive(managedId);
    if (managed?.scope_type === "task" && managed.scope_id === taskId) refs.add(artifactRef(managed.id));
  }
  return [...refs];
}
