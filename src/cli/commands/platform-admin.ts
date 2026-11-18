import { Database } from "bun:sqlite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { join } from "node:path";
import { readOption } from "@luna/cli-support/options";
import type { CliResult, Env } from "@luna/cli-support/types";
import { defaultLunaHome } from "@luna/host-runtime/env";
import { assertDatabaseBaseline } from "@/data/schema-baseline";
import { resolveMigrationsFolder } from "@/data/data-connection";
import { accounts } from "@/data/schema";
import { AuthorizationRuleStore } from "@/server/policy/authorization-rule-store";
import { isPlatformAdministrator } from "@/server/policy/platform-administrator";

const usage = "luna service admin grant --account-id <account-id> [--home <path>]";

/** Host operators with database write access can provision a named Dashboard administrator. */
export function runPlatformAdminCli(argv: string[], env: Env): CliResult {
  if (!argv.length || argv[0] === "--help" || argv[0] === "-h") {
    return { status: "ok", output: usage };
  }
  try {
    const accountId = readOption(argv, "--account-id")?.trim();
    if (argv[0] !== "grant" || !accountId) throw new Error(usage);
    const home = readOption(argv, "--home") ?? defaultLunaHome(env);
    const sqlite = new Database(join(home, "data", "luna.db"), { readwrite: true, create: false });
    try {
      sqlite.run("PRAGMA busy_timeout = 5000");
      const db = drizzle(sqlite);
      const grantId = sqlite.transaction(() => {
        if (assertDatabaseBaseline(sqlite, resolveMigrationsFolder())) {
          throw new Error("Start Luna Service and sign in before granting platform administration.");
        }
        const account = db.select().from(accounts).where(eq(accounts.id, accountId)).get();
        if (account?.status !== "active") {
          throw new Error("Choose the ID of an active account; it exists once its owner has signed in.");
        }
        const grants = new AuthorizationRuleStore(db, {kind: "platform"});
        const grant = grants.addGrant({subjectType: "user", subjectId: accountId, target: "system.admin", effect: "allow"});
        if (!isPlatformAdministrator(db, accountId)) {
          throw new Error("An existing platform rule prevents this account from becoming an administrator.");
        }
        return grant.id;
      }).immediate();
      return {status: "ok", output: JSON.stringify({accountId, grantId})};
    } finally {
      sqlite.close();
    }
  } catch (error) {
    return {status: "error", code: "platform_admin_grant_failed", message: error instanceof Error ? error.message : String(error)};
  }
}
