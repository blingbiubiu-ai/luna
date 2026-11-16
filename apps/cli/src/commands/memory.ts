import type { CliResult, Env } from "@luna/cli-support/types";
import { bodyWithDefinedValues, hasFlag, readOption } from "@luna/cli-support/options";
import { callUnifiedService, servicePathWithQuery } from "@luna/cli-support/service-client";

const usage = [
  "luna memory list [--type persona|person|feedback|project|procedure|reference] [--limit N]",
  "luna memory search <keywords> [--type T] [--subject USER_ID] [--archived]   # --archived searches forgotten entries",
  "luna memory get <id>",
  "luna memory add --type T --title TITLE --description DESC [--subject USER_ID] [--visibility agent|shadow] [--expires YYYY-MM-DD] [--core true] [--force] (--body TEXT | --stdin)",
  "luna memory update <id> --expected-revision N [--type T] [--title TITLE] [--description DESC] [--subject USER_ID|none] [--visibility agent|shadow] [--expires YYYY-MM-DD|none] [--core true|false] [--body TEXT | --stdin]",
  "luna memory restore <id> --expected-revision N   # bring a forgotten entry back",
  "luna memory delete <id> --expected-revision N [--superseded-by ID]",
].join("\n");
const SEARCH_VALUE_OPTIONS = new Set(["--type", "--subject", "--limit"]);

/** Agent memory for the current invocation; Service derives scope and write authority from the token. */
export async function runMemoryCli(argv: readonly string[], env: Env, readStdin: () => Promise<string> = () => Bun.stdin.text()): Promise<CliResult> {
  const command = argv[0];
  if (!command || command === "help" || hasFlag(argv, "--help") || hasFlag(argv, "-h")) return {status: "ok", output: usage};
  try {
    const option = (name: string) => readOption(argv, name);
    const id = () => {
      const value = argv[1];
      if (!value || value.startsWith("--")) throw new Error("missing memory id");
      return `/api/runner/memory/${encodeURIComponent(value)}`;
    };
    const revision = () => {
      const value = Number(option("--expected-revision"));
      if (!Number.isInteger(value) || value < 1) throw new Error("--expected-revision must be the revision returned by get, list or search");
      return value;
    };
    /** A date expires at the end of that day (UTC); `none` clears the expiry. */
    const expires = () => {
      const value = option("--expires");
      if (value === undefined) return undefined;
      if (value === "none") return null;
      const time = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59Z` : value);
      if (!Number.isFinite(time)) throw new Error("--expires must be YYYY-MM-DD, an ISO timestamp or none");
      return time;
    };
    const core = () => {
      const value = option("--core");
      if (value !== undefined && value !== "true" && value !== "false") throw new Error("--core must be true or false");
      return value === undefined ? undefined : value === "true";
    };
    /** `none` clears the subject, so a misfiled `person` entry can become another type. */
    const subject = () => {
      const value = option("--subject");
      return value === "none" ? null : value;
    };
    const fields = async () => {
      if (hasFlag(argv, "--stdin") && option("--body") !== undefined) throw new Error("use either --body or --stdin, not both");
      return bodyWithDefinedValues({
        expiresAt: expires(), core: core(),
        type: option("--type"), title: option("--title"), description: option("--description"),
        subjectUserId: subject(), visibility: option("--visibility"),
        body: hasFlag(argv, "--stdin") ? await readStdin() : option("--body"),
      });
    };
    if (command === "list") return callUnifiedService(env, {method: "GET", path: servicePathWithQuery("/api/runner/memory", {type: option("--type"), limit: option("--limit")})});
    if (command === "search") {
      // Keywords are the words that are neither flags nor flag values, wherever they appear.
      const words: string[] = [];
      for (let index = 1; index < argv.length; index++) {
        const arg = argv[index]!;
        if (arg.startsWith("--")) { if (SEARCH_VALUE_OPTIONS.has(arg)) index++; continue; }
        words.push(arg);
      }
      const q = words.join(" ").trim();
      if (!q) throw new Error("missing search keywords");
      return callUnifiedService(env, {method: "GET", path: servicePathWithQuery("/api/runner/memory/search", {q, type: option("--type"), subject: option("--subject"), archived: hasFlag(argv, "--archived") ? "true" : undefined})});
    }
    if (command === "get") return callUnifiedService(env, {method: "GET", path: id()});
    if (command === "add") return callUnifiedService(env, {method: "POST", path: "/api/runner/memory", body: {...await fields(), ...(hasFlag(argv, "--force") ? {force: true} : {})}});
    if (command === "restore") return callUnifiedService(env, {method: "POST", path: `${id()}/restore`, body: {expectedRevision: revision()}});
    if (command === "update") return callUnifiedService(env, {method: "PUT", path: id(), body: {...await fields(), expectedRevision: revision()}});
    if (command === "delete") return callUnifiedService(env, {method: "DELETE", path: servicePathWithQuery(id(), {expectedRevision: String(revision()), supersededBy: option("--superseded-by")})});
    throw new Error(usage);
  } catch (error) {
    return {status: "error", code: "invalid_memory_command", message: error instanceof Error ? error.message : String(error)};
  }
}
