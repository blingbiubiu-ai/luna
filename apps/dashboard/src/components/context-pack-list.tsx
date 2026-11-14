import { UiText } from "@/lib/i18n";
import { useTranslation } from "@/lib/i18n";
import type {
  DashboardContextPack,
  DashboardContextPackItem,
  DashboardRunnerContextSeedRecord,
  DashboardTaskRunContextSummary,
} from "@/lib/api";

import { CopyTextButton } from "@/components/copy-text-button";
import { InspectableText } from "@/components/inspectable-text";

export function ContextPackList({
  title = "Context Packs",
  packs,
  emptyText = "No context packs recorded.",
  defaultOpen = true,
}: {
  readonly title?: string;
  readonly packs: readonly DashboardContextPack[];
  readonly emptyText?: string;
  readonly defaultOpen?: boolean;
}) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase text-muted-foreground">
        <UiText>{title}</UiText>
      </h3>
      {packs.length === 0 ? (
        <div className="rounded-md border bg-muted/20 p-3 text-sm text-muted-foreground">
          <UiText>{emptyText}</UiText>
        </div>
      ) : (
        <div className="grid gap-2 text-sm">
          {packs.map((pack) => (
            <ContextPackDetails
              defaultOpen={defaultOpen}
              key={pack.id}
              pack={pack}
            />
          ))}
        </div>
      )}
    </section>
  );
}

export function SeedRecordList({
  title = "Seed Records",
  records,
  emptyText = "No seed records recorded.",
}: {
  readonly title?: string;
  readonly records: readonly DashboardRunnerContextSeedRecord[];
  readonly emptyText?: string;
}) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase text-muted-foreground">
        <UiText>{title}</UiText>
      </h3>
      {records.length === 0 ? (
        <div className="rounded-md border bg-muted/20 p-3 text-sm text-muted-foreground">
          <UiText>{emptyText}</UiText>
        </div>
      ) : (
        <div className="grid gap-2 text-sm">
          {records.map((record) => (
            <SeedRecordRow key={record.id} record={record} />
          ))}
        </div>
      )}
    </section>
  );
}

export function RunContextSummaryList({
  summaries,
  emptyText = "No run context summaries recorded.",
}: {
  readonly summaries: readonly DashboardTaskRunContextSummary[];
  readonly emptyText?: string;
}) {
  const { t } = useTranslation();
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase text-muted-foreground">{t("Run Context Summaries")}</h3>
      {summaries.length === 0 ? (
        <div className="rounded-md border bg-muted/20 p-3 text-sm text-muted-foreground">
          <UiText>{emptyText}</UiText>
        </div>
      ) : (
        <div className="grid gap-2 text-sm">
          {summaries.map((summary) => (
            <RunContextSummaryRow key={summary.runId} summary={summary} />
          ))}
        </div>
      )}
    </section>
  );
}

export function RunContextSummaryInline({
  run,
}: {
  readonly run: DashboardRunContextLike;
}) {
  const { t } = useTranslation();
  const contextPackIds = runContextPackIds(run);
  const seedRecords = run.seedRecords ?? [];
  const hasMaterializedPrompt = runHasMaterializedPrompt(run);

  if (
    contextPackIds.length === 0 &&
    seedRecords.length === 0 &&
    !hasMaterializedPrompt
  ) {
    return null;
  }

  return (
    <div className="mt-2 space-y-1 rounded-[4px] border bg-muted/20 p-2 font-sans text-[11px] leading-5 text-muted-foreground">
      <div className="flex flex-wrap gap-x-2 gap-y-1">
        <span>{t("has prompt")}{" "}<UiText>{String(hasMaterializedPrompt)}</UiText></span>
        <span>{t("Context packs")}</span>
        {contextPackIds.length === 0 ? (
          <span>-</span>
        ) : (
          contextPackIds.map((packId) => (
            <span className="font-mono text-foreground" key={packId}>
              {packId}
            </span>
          ))
        )}
      </div>
      <div className="flex flex-wrap gap-x-2 gap-y-1">
        <span>{t("Seed records")}</span>
        {seedRecords.length === 0 ? (
          <span>-</span>
        ) : (
          seedRecords.map((record) => (
            <span className="font-mono text-foreground" key={record.id}>
              {record.id}
            </span>
          ))
        )}
      </div>
    </div>
  );
}

function ContextPackDetails({
  pack,
  defaultOpen,
}: {
  readonly pack: DashboardContextPack;
  readonly defaultOpen: boolean;
}) {
  const { t } = useTranslation();
  const triggerIds = [pack.triggerEntryId, pack.triggerMessageId]
    .filter(Boolean)
    .join(" / ");

  return (
    <details
      className="rounded-md border bg-muted/20 p-3"
      data-testid={`context-pack-${pack.id}`}
      open={defaultOpen}
    >
      <summary className="cursor-pointer list-none">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <span className="font-medium"><UiText>{pack.kind}</UiText></span>
          <span className="font-mono text-xs text-muted-foreground">
            {pack.id}
          </span>
          <span className="text-xs text-muted-foreground">
            {pack.selectionStrategy}
          </span>
          <span className="text-xs text-muted-foreground">
            {pack.itemCount}{t("items")}</span>
          <CopyTextButton
            className="h-6 px-2 text-xs"
            label={`Copy context pack JSON ${pack.id}`}
            text={formatJsonForCopy(pack)}
          >{t("Copy JSON")}</CopyTextButton>
        </div>
        {triggerIds ? (
          <div className="mt-1 font-mono text-[11px] text-muted-foreground">{t("trigger")}{triggerIds}
          </div>
        ) : null}
      </summary>
      <div className="mt-3 overflow-hidden rounded-[4px] border bg-background/50">
        <table className="w-full table-fixed text-xs">
          <thead>
            <tr className="border-b text-muted-foreground">
              <th className="w-28 px-2 py-1.5 text-left font-medium">{t("Role")}</th>
              <th className="w-40 px-2 py-1.5 text-left font-medium">{t("Reason")}</th>
              <th className="px-2 py-1.5 text-left font-medium">{t("Preview")}</th>
              <th className="w-52 px-2 py-1.5 text-left font-medium">{t("Source")}</th>
            </tr>
          </thead>
          <tbody>
            {pack.items.map((item) => (
              <ContextPackItemRow item={item} key={item.id} />
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}

function ContextPackItemRow({
  item,
}: {
  readonly item: DashboardContextPackItem;
}) {
  const { t } = useTranslation();
  return (
    <tr className="border-b last:border-b-0">
      <td className="whitespace-normal break-words px-2 py-1.5 align-top">
        <div className="font-medium"><UiText>{item.role}</UiText></div>
        <div className="font-mono text-[11px] text-muted-foreground">
          {item.itemKind}:{item.itemId}
        </div>
      </td>
      <td className="whitespace-normal break-words px-2 py-1.5 align-top">
        <InspectableText
          label={t("Reason")}
          previewLength={72}
          text={item.reason || "-"}
        />
      </td>
      <td className="whitespace-normal break-words px-2 py-1.5 align-top">
        <InspectableText
          label={t("Message preview")}
          previewLength={120}
          text={item.messagePreview ?? "-"}
        />
      </td>
      <td className="whitespace-normal break-words px-2 py-1.5 align-top font-mono text-[11px] text-muted-foreground">
        {item.sourceSessionId ? <div>session {item.sourceSessionId}</div> : null}
        {item.sourceEntryId ? <div>{t("entry")}{" "}{item.sourceEntryId}</div> : null}
        {item.sourceMessageId ? <div>{t("message")}{" "}{item.sourceMessageId}</div> : null}
      </td>
    </tr>
  );
}

function SeedRecordRow({
  record,
}: {
  readonly record: DashboardRunnerContextSeedRecord;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-mono text-xs">{record.id}</span>
        <span className="text-xs text-muted-foreground">{t("runner")}{record.runnerContextId}
        </span>
        <span className="text-xs text-muted-foreground">{t("pack")}{record.seedContextPackId}
        </span>
        <CopyTextButton
          className="h-6 px-2 text-xs"
          label={`Copy seed record JSON ${record.id}`}
          text={formatJsonForCopy(record)}
        >{t("Copy JSON")}</CopyTextButton>
      </div>
      <div className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
        <ContextIdList label={t("Seed entries")} values={record.seedEntryIds} />
        <ContextIdList label={t("Seed items")} values={record.seedContextItemIds} />
      </div>
    </div>
  );
}

function RunContextSummaryRow({
  summary,
}: {
  readonly summary: DashboardTaskRunContextSummary;
}) {
  const { t } = useTranslation();
  return (
    <div className="rounded-md border bg-muted/20 p-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="font-medium">{t("Run #")}{summary.runIndex}</span>
        <span className="font-mono text-xs text-muted-foreground">
          {summary.runId}
        </span>
        <span className="text-xs text-muted-foreground">{t("has prompt")}{" "}<UiText>{String(summary.hasMaterializedPrompt)}</UiText>
        </span>
        {summary.runnerContextId ? (
          <span className="text-xs text-muted-foreground">{t("runner")}{summary.runnerContextId}
          </span>
        ) : null}
        <CopyTextButton
          className="h-6 px-2 text-xs"
          label={`Copy run context summary JSON ${summary.runId}`}
          text={formatJsonForCopy(summary)}
        >{t("Copy JSON")}</CopyTextButton>
      </div>
      <div className="mt-2 grid gap-1 text-xs text-muted-foreground sm:grid-cols-2">
        <ContextIdList label={t("Context packs")} values={summary.contextPackIds} />
        <ContextIdList
          label={t("Seed context packs")}
          values={summary.seedContextPackIds}
        />
      </div>
    </div>
  );
}

function ContextIdList({
  label,
  values,
}: {
  readonly label: string;
  readonly values: readonly string[];
}) {
  return (
    <div className="min-w-0">
      <span><UiText>{label}</UiText>: </span>
      {values.length === 0 ? (
        <span>-</span>
      ) : (
        <InspectableText
          label={label}
          previewClassName="font-mono"
          previewLength={96}
          text={values.join(", ")}
        />
      )}
    </div>
  );
}

function runContextPackIds(
  run: DashboardRunContextLike,
): readonly string[] {
  const ids = run.contextPackIds ?? [];
  if (ids.length > 0) {
    return ids;
  }
  return (run.contextPacks ?? []).map((pack) => pack.id);
}

function runHasMaterializedPrompt(
  run: DashboardRunContextLike,
): boolean {
  if (typeof run.hasMaterializedPrompt === "boolean") {
    return run.hasMaterializedPrompt;
  }
  return Boolean(run.materializedPrompt ?? run.materialized_prompt);
}

function formatJsonForCopy(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

interface DashboardRunContextLike {
  readonly contextPackIds?: readonly string[];
  readonly contextPacks?: readonly DashboardContextPack[];
  readonly hasMaterializedPrompt?: boolean;
  readonly materializedPrompt?: string | null;
  readonly materialized_prompt?: string | null;
  readonly seedRecords?: readonly DashboardRunnerContextSeedRecord[];
}
