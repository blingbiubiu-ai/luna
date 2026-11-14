import { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { join } from "node:path";
import { readOption } from "@luna/cli-support/options";
import type { CliResult, Env } from "@luna/cli-support/types";
import { defaultLunaHome } from "@luna/host-runtime/env";
import { assertDatabaseBaseline } from "@/data/schema-baseline";
import { resolveMigrationsFolder } from "@/data/data-connection";
import { users } from "@/data/schema";
import { AuthorizationRuleStore } from "@/server/policy/authorization-rule-store";
import { isPlatformAdministrator } from "@/server/policy/platform-administrator";

const usage = "luna service admin grant --user-id <canonical-user-id> [--home <path>]";

/** Host operators with database write access can provision a named Dashboard administrator. */
export function runPlatformAdminCli(argv: string[], env: Env): CliResult {
  if (!argv.length || argv[0] === "--help" || argv[0] === "-h") {
    return { status: "ok", output: usage };
  }
  try {
    const userId = readOption(argv, "--user-id")?.trim();
    if (argv[0] !== "grant" || !userId) throw new Error(usage);
    const home = readOption(argv, "--home") ?? defaultLunaHome(env);
    const sqlite = new Database(join(home, "data", "luna.db"), { readwrite: true, create: false });
    try {
      sqlite.run("PRAGMA busy_timeout = 5000");
      const db = drizzle(sqlite);
      const grantId = sqlite.transaction(() => {
        if (assertDatabaseBaseline(sqlite, resolveMigrationsFolder())) {
          throw new Error("Start Luna Service and sign in before granting platform administration.");
        }
        const user = db.select().from(users).where(eq(users.id, userId)).get();
        if (user?.kind !== "human" || user.status !== "active") {
          throw new Error("Choose the canonical ID of an active human Luna user.");
        }
        const grants = new AuthorizationRuleStore(db, {kind: "platform"});
        const grant = grants.addGrant({subjectType: "user", subjectId: userId, target: "system.admin", effect: "allow"});
        if (!isPlatformAdministrator(db, userId)) {
          throw new Error("An existing platform rule prevents this user from becoming an administrator.");
        }
        return grant.id;
      }).immediate();
      return {status: "ok", output: JSON.stringify({userId, grantId})};
    } finally {
      sqlite.close();
    }
  } catch (error) {
    return {status: "error", code: "platform_admin_grant_failed", message: error instanceof Error ? error.message : String(error)};
  }
}
