import { useTranslation } from "@/lib/i18n";
import { useState } from "react";
import type { ReactNode } from "react";

import { ActionDialog } from "@/components/action-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function CreateGroupDialog({
  disabled = false,
  error,
  isSubmitting = false,
  onCreate,
}: {
  readonly disabled?: boolean;
  readonly error?: unknown;
  readonly isSubmitting?: boolean;
  readonly onCreate?: ((input: {
    slug: string;
    displayName: string;
    description?: string;
  }) => Promise<unknown> | unknown) | undefined;
}) {
  const { t } = useTranslation();
  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const trimmedSlug = slug.trim();
  const trimmedDisplayName = displayName.trim();
  const trimmedDescription = description.trim();

  return (
    <ActionDialog
      error={error}
      isSubmitting={isSubmitting}
      onSubmit={() =>
        onCreate?.({
          slug: trimmedSlug,
          displayName: trimmedDisplayName,
          ...(trimmedDescription.length === 0
            ? {}
            : { description: trimmedDescription }),
        })
      }
      onSuccess={() => {
        setSlug("");
        setDisplayName("");
        setDescription("");
      }}
      submitDisabled={disabled || trimmedSlug.length === 0 || trimmedDisplayName.length === 0}
      submitLabel={t("Create group")}
      title={t("Create group")}
      trigger={<Button disabled={disabled}>{t("Create group")}</Button>}
    >
      <Field label={t("Group slug *")}>
        <Input
          aria-label={t("Group slug")}
          onChange={(event) => setSlug(readInputValue(event.currentTarget))}
          placeholder="group-slug"
          value={slug}
        />
      </Field>
      <Field label={t("Display name *")}>
        <Input
          aria-label={t("Group display name")}
          onChange={(event) => setDisplayName(readInputValue(event.currentTarget))}
          placeholder={t("Display name")}
          value={displayName}
        />
      </Field>
      <Field label={t("Description")}>
        <Input
          aria-label={t("Group description")}
          onChange={(event) => setDescription(readInputValue(event.currentTarget))}
          placeholder={t("Optional description")}
          value={description}
        />
      </Field>
    </ActionDialog>
  );
}

function readInputValue(target: EventTarget): string {
  return (target as { value?: string }).value ?? "";
}

function Field({
  children,
  label,
}: {
  readonly children: ReactNode;
  readonly label: string;
}) {
  return (
    <label className="grid gap-2 text-sm">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
