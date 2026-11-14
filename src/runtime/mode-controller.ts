import { ExecutionError, type SqlDatabase } from "@luna/execution-store";
import type { RuntimeConfig } from "./config";

type Mode = RuntimeConfig["mode"];
interface ModeState { mode: Mode; draining: boolean; }

/** Pause admission while existing Shadow Jobs finish. */
export class RuntimeModeController {
  constructor(private readonly db: SqlDatabase, config: RuntimeConfig) {
    if (config.mode !== "shared") throw new ExecutionError(409, "isolated_mode_unsupported");
    db.exec("CREATE TABLE IF NOT EXISTS runtime_mode (singleton INTEGER PRIMARY KEY CHECK(singleton=1), mode TEXT NOT NULL, draining INTEGER NOT NULL)");
    db.prepare("INSERT OR IGNORE INTO runtime_mode VALUES (1,?,0)").run(config.mode);
    if (this.state().mode !== "shared") throw new ExecutionError(409, "isolated_mode_unsupported");
  }
  state(): ModeState {
    const row = this.db.prepare("SELECT mode,draining FROM runtime_mode WHERE singleton=1").get() as { mode: Mode; draining: number };
    return { mode: row.mode, draining: Boolean(row.draining) };
  }
  requireAdmission(): void { if (this.state().draining) throw new ExecutionError(503, "runtime_draining"); }
  drain(): ModeState { this.db.prepare("UPDATE runtime_mode SET draining=1 WHERE singleton=1").run(); return this.state(); }
  resume(): ModeState {
    this.db.prepare("UPDATE runtime_mode SET draining=0 WHERE singleton=1").run();
    return this.state();
  }
  change(mode: Mode): ModeState {
    if (mode !== "shared") throw new ExecutionError(409, "isolated_mode_unsupported");
    return this.state();
  }
}
