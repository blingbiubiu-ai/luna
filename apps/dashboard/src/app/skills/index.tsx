import { UiText } from "@/lib/i18n";
import { useTranslation } from "@/lib/i18n";
import { createFileRoute } from "@tanstack/react-router";
import { BadgeInfoIcon, SparklesIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { useSkill, useSkills } from "@/lib/api";
import type { Skill, SkillDetail as SkillDetailRecord } from "@/types/agentara";

export const Route = createFileRoute("/$agentId/skills/")({
  component: SkillsPage,
});

function SkillsPage() {
  const { t } = useTranslation();
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const skills = useSkills();
  const entries = useMemo(
    () => skills.data?.entries ?? [],
    [skills.data?.entries],
  );
  const selectedSkill = useSkill(selectedSlug);
  const skill =
    selectedSkill.data ?? entries.find((entry) => entry.slug === selectedSlug);

  useEffect(() => {
    if (selectedSlug === null && entries.length > 0) {
      setSelectedSlug(entries[0]?.slug ?? null);
    }
  }, [entries, selectedSlug]);

  return (
    <main className="flex min-h-0 flex-1 flex-col bg-background">
      <header className="border-b px-5 py-4">
        <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
          <SparklesIcon className="size-4" />{t("Skills")}</div>
        <div className="mt-2 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold">{t("Runner Skills")}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t("Installed skills available to Luna runners")}</p>
          </div>
          <Badge variant="outline">{entries.length}{t("installed")}</Badge>
        </div>
      </header>
      <section className="grid min-h-0 flex-1 gap-4 p-5 xl:grid-cols-[22rem_1fr]">
        <aside className="min-h-0 rounded-md border">
          <h2 className="border-b px-3 py-2 text-sm font-medium">{t("Skills")}</h2>
          <div className="max-h-full overflow-auto p-2">
            {skills.isLoading ? <SkillsListSkeleton /> : null}
            {entries.length === 0 && !skills.isLoading ? <EmptyState /> : null}
            {entries.map((entry) => (
              <SkillButton
                key={entry.slug}
                selected={entry.slug === selectedSlug}
                skill={entry}
                onSelect={setSelectedSlug}
              />
            ))}
          </div>
        </aside>
        <article className="min-w-0 rounded-md border">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b px-3 py-2">
            <div className="flex min-w-0 items-center gap-2 text-sm font-medium">
              <SparklesIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="truncate">{skill?.name ?? "Select a skill"}</span>
            </div>
            {skill?.license ? (
              <Badge variant="outline">{skill.license}</Badge>
            ) : (
              <span className="text-xs text-muted-foreground">{t("No license")}</span>
            )}
          </div>
          <div className="border-b px-3 py-2 text-xs text-muted-foreground">
            {skill?.slug ?? "Select a skill from the list."}
          </div>
          <div className="grid gap-4 p-4">
            {selectedSkill.isLoading ? (
              <SkillDetailSkeleton />
            ) : selectedSkill.data ? (
              <SkillDetail skill={selectedSkill.data} />
            ) : null}
          </div>
        </article>
      </section>
    </main>
  );
}

function SkillButton({
  skill,
  selected,
  onSelect,
}: {
  readonly skill: Skill;
  readonly selected: boolean;
  readonly onSelect: (slug: string) => void;
}) {
  return (
    <button
      className={
        "grid w-full gap-1 rounded-md px-2 py-2 text-left text-sm hover:bg-accent " +
        (selected ? "bg-accent" : "")
      }
      onClick={() => onSelect(skill.slug)}
      title={skill.slug}
      type="button"
    >
      <span className="flex min-w-0 items-center gap-2">
        <SparklesIcon className="size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 truncate font-medium">{skill.name}</span>
        {skill.license ? (
          <span className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground">
            {skill.license}
          </span>
        ) : null}
      </span>
      <span className="truncate font-mono text-xs text-muted-foreground">
        {skill.slug}
      </span>
      <span className="line-clamp-2 text-xs text-muted-foreground">
        {skill.description}
      </span>
    </button>
  );
}

function SkillDetail({ skill }: { readonly skill: SkillDetailRecord }) {
  const { t } = useTranslation();
  const metadata = [
    ["Slug", skill.slug],
    ["Name", skill.name],
    ["License", skill.license ?? "None"],
  ] as const;

  return (
    <>
      <section className="grid gap-2 rounded-md border p-3">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <BadgeInfoIcon className="size-4" />{t("Metadata")}</h2>
        <div className="grid gap-2 text-sm">
          {metadata.map(([label, value]) => (
            <div className="grid gap-1 sm:grid-cols-[7rem_1fr]" key={label}>
              <span className="text-xs text-muted-foreground"><UiText>{label}</UiText></span>
              <span className="break-all font-mono text-xs">{value}</span>
            </div>
          ))}
        </div>
      </section>
      <section className="grid gap-2 rounded-md border p-3">
        <h2 className="text-sm font-medium">SKILL.md</h2>
        <Textarea
          className="min-h-[28rem] resize-none font-mono text-sm leading-6"
          readOnly
          value={skill.content}
        />
      </section>
    </>
  );
}

function SkillsListSkeleton() {
  return (
    <div className="grid gap-2">
      {Array.from({ length: 6 }).map((_, index) => (
        <div className="grid gap-2 rounded-md px-2 py-2" key={index}>
          <Skeleton className="h-4 w-36" />
          <Skeleton className="h-3 w-24" />
          <Skeleton className="h-8 w-full" />
        </div>
      ))}
    </div>
  );
}

function SkillDetailSkeleton() {
  return (
    <div className="grid gap-4">
      <Skeleton className="h-28 w-full rounded-md" />
      <Skeleton className="h-72 w-full rounded-md" />
    </div>
  );
}

function EmptyState() {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-24 text-muted-foreground">
      <SparklesIcon className="size-10 opacity-30" />
      <p className="text-sm">{t("No skills installed")}</p>
      <p className="text-xs">{t("Install skills through the runner skills configuration.")}</p>
    </div>
  );
}
