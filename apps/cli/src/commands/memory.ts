import type { CliResult, Env } from "@luna/cli-support/types";
import { bodyWithDefinedValues, hasFlag, parseDurationSeconds, readOption } from "@luna/cli-support/options";
import { callUnifiedService, servicePathWithQuery } from "@luna/cli-support/service-client";

const usage = [
  "luna memory list [--type persona|person|chat|feedback|project|procedure|reference|episode] [--limit N]",
  "luna memory search <keywords> [--type T] [--subject USER_ID] [--archived] [--ancestors] [--max-depth N]   # --ancestors searches older lineage generations",
  "luna memory lineage   # show current inherited lineage chain",
  "luna memory contribute --kind add|update [--target LMEM_ID] --type procedure|feedback|reference|project --title TITLE --description DESC [--source-memory MEM_ID] [--rationale WHY] (--body TEXT | --stdin)",
  "luna memory timeline [--since 7d|YYYY-MM-DD] [--until YYYY-MM-DD] [--shadow SHADOW_ID] [--with USER_ID] [--limit N] [--archived]   # what happened, newest first",
  "luna memory get <id>",
  "luna memory add --type T --title TITLE --description DESC [--subject USER_ID] [--visibility agent|shadow] [--expires YYYY-MM-DD] [--core true] [--force] (--body TEXT | --stdin)",
  "luna memory update <id> --expected-revision N --reason WHY [--type T] [--title TITLE] [--description DESC] [--subject USER_ID|none] [--visibility agent|shadow] [--expires YYYY-MM-DD|none] [--core true|false] [--body TEXT | --stdin | --replace-old OLD --replace-new NEW ...]",
  "luna memory restore <id> --expected-revision N --reason WHY   # bring a forgotten entry back",
  "luna memory delete <id> --expected-revision N --reason WHY [--superseded-by ID]",
  "  --reason is one line on why you change the entry, kept with the version it writes, e.g. \"the user moved the launch to 2026-12-05\"",
  "",
  "Types (one question each):",
  "  person     who someone is and how to work with them (--subject USER_ID)",
  "  chat       who you are and what you do in this group or direct chat, e.g. its on-call owner; bound to the current chat, told in every conversation there",
  "  feedback   a way of working the user corrected or confirmed",
  "  project    state, decisions or schedule of ongoing work",
  "  procedure  reusable steps, e.g. how to troubleshoot something",
  "  reference  where something is found: a link, path or 《document name》; must contain one",
  "  persona    who this Shadow is (Agent owner only); episode is written by memory reflection",
].join("\n");
const SEARCH_VALUE_OPTIONS = new Set(["--type", "--subject", "--limit", "--max-depth"]);
const KNOWN_FLAGS = new Set([
  "--type", "--title", "--description", "--subject", "--visibility", "--expires", "--core",
  "--body", "--stdin", "--force", "--expected-revision", "--reason", "--superseded-by",
  "--replace-old", "--replace-new", "--since", "--until", "--shadow", "--with", "--limit",
  "--archived", "--ancestors", "--max-depth", "--kind", "--target", "--source-memory", "--rationale", "--batch-id",
  "--help", "-h",
]);

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
      if (!Number.isInteger(value) || value < 1) throw new Error("--expected-revision is required; before changing a body, read the full entry with luna memory get <id>");
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
    /** `none` clears the subject, so a misfiled `person` entry can become another type. A `chat` entry takes the current chat. */
    const subject = () => {
      const value = option("--subject");
      return value === "none" ? null : value;
    };
    const replacements = () => {
      const olds: string[] = [];
      const news: string[] = [];
      for (let index = 1; index < argv.length; index++) {
        const arg = argv[index]!;
        if (arg !== "--replace-old" && arg !== "--replace-new") continue;
        const next = argv[index + 1];
        if (next === undefined || KNOWN_FLAGS.has(next)) throw new Error(`missing value for ${arg}`);
        index++;
        if (arg === "--replace-old") {
          if (!next) throw new Error("--replace-old must be non-empty");
          olds.push(next);
        } else {
          news.push(next);
        }
      }
      if (olds.length !== news.length) throw new Error("each --replace-old requires a matching --replace-new");
      return olds.length ? olds.map((oldText, idx) => ({old: oldText, new: news[idx]!})) : undefined;
    };
    const fields = async (allowReplace = false) => {
      if (hasFlag(argv, "--stdin") && option("--body") !== undefined) throw new Error("use either --body or --stdin, not both");
      const replace = replacements();
      if (replace && !allowReplace) throw new Error("--replace-old/--replace-new is only valid with luna memory update");
      if (replace && (hasFlag(argv, "--stdin") || option("--body") !== undefined)) {
        throw new Error("use either --replace-old/--replace-new or --body/--stdin, not both");
      }
      return bodyWithDefinedValues({
        expiresAt: expires(), core: core(),
        type: option("--type"), title: option("--title"), description: option("--description"),
        subjectId: subject(), visibility: option("--visibility"),
        body: hasFlag(argv, "--stdin") ? await readStdin() : option("--body"),
        replace,
      });
    };
    if (command === "list") return callUnifiedService(env, {method: "GET", path: servicePathWithQuery("/api/runner/memory", {type: option("--type"), limit: option("--limit")})});
    if (command === "lineage") return callUnifiedService(env, {method: "GET", path: "/api/runner/memory/lineage"});
    if (command === "contribute") {
      if (hasFlag(argv, "--stdin") && option("--body") !== undefined) throw new Error("use either --body or --stdin, not both");
      return callUnifiedService(env, {
        method: "POST",
        path: "/api/runner/memory/contribute",
        body: bodyWithDefinedValues({
          kind: option("--kind") ?? "add",
          targetLineageMemoryId: option("--target"),
          sourceLocalMemoryId: option("--source-memory"),
          type: option("--type"),
          title: option("--title"),
          description: option("--description"),
          body: hasFlag(argv, "--stdin") ? await readStdin() : option("--body"),
          rationale: option("--rationale"),
          batchId: option("--batch-id"),
        }),
      });
    }
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
      return callUnifiedService(env, {method: "GET", path: servicePathWithQuery("/api/runner/memory/search", {
        q,
        type: option("--type"),
        subject: option("--subject"),
        archived: hasFlag(argv, "--archived") ? "true" : undefined,
        ancestors: hasFlag(argv, "--ancestors") ? "true" : undefined,
        maxDepth: option("--max-depth"),
      })});
    }
    if (command === "timeline") {
      /** A duration such as 7d or 12h counts back from now; a date is read as given. */
      const moment = (name: string, endOfDay = false) => {
        const value = option(name);
        if (value === undefined) return undefined;
        if (/^\d+[smhd]$/.test(value)) return String(Date.now() - parseDurationSeconds(value) * 1000);
        const parsed = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T${endOfDay ? "23:59:59" : "00:00:00"}Z` : value);
        if (!Number.isFinite(parsed)) throw new Error(`${name} must be a duration such as 7d, YYYY-MM-DD or an ISO timestamp`);
        return String(parsed);
      };
      return callUnifiedService(env, {method: "GET", path: servicePathWithQuery("/api/runner/memory/timeline", {
        since: moment("--since"), until: moment("--until", true), shadow: option("--shadow"), with: option("--with"),
        limit: option("--limit"), archived: hasFlag(argv, "--archived") ? "true" : undefined})});
    }
    if (command === "get") return callUnifiedService(env, {method: "GET", path: id()});
    if (command === "add") return callUnifiedService(env, {method: "POST", path: "/api/runner/memory", body: {...await fields(), ...(hasFlag(argv, "--force") ? {force: true} : {})}});
    if (command === "restore") return callUnifiedService(env, {method: "POST", path: `${id()}/restore`, body: bodyWithDefinedValues({expectedRevision: revision(), reason: option("--reason")})});
    if (command === "update") return callUnifiedService(env, {method: "PUT", path: id(), body: {...await fields(true), ...bodyWithDefinedValues({reason: option("--reason")}), expectedRevision: revision()}});
    if (command === "delete") return callUnifiedService(env, {method: "DELETE", path: servicePathWithQuery(id(), {expectedRevision: String(revision()), supersededBy: option("--superseded-by"), reason: option("--reason")})});
    throw new Error(usage);
  } catch (error) {
    return {status: "error", code: "invalid_memory_command", message: error instanceof Error ? error.message : String(error)};
  }
}
