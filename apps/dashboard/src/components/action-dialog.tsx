import { UiText } from "@/lib/i18n";
import { useTranslation } from "@/lib/i18n";
import type { ReactNode } from "react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

export function ActionDialog({
  children,
  description,
  error,
  isSubmitting = false,
  onSubmit,
  onSuccess,
  submitDisabled = false,
  submitLabel,
  title,
  trigger,
}: {
  readonly children: ReactNode;
  readonly description?: string;
  readonly error?: unknown;
  readonly isSubmitting?: boolean;
  readonly onSubmit: () => Promise<unknown> | unknown;
  readonly onSuccess?: () => void;
  readonly submitDisabled?: boolean;
  readonly submitLabel: string;
  readonly title: string;
  readonly trigger: ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const errorText = formatDialogError(error);

  async function handleSubmit() {
    await onSubmit();
    onSuccess?.();
    setOpen(false);
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent
        className="min-w-0 overflow-visible sm:max-w-2xl"
        data-testid="action-dialog-content"
      >
        <form
          className="grid min-w-0 gap-4"
          data-testid="action-dialog-form"
          onSubmit={(event) => {
            event.preventDefault();
            void handleSubmit().catch(() => undefined);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t(title)}</DialogTitle>
            {description ? (
              <DialogDescription>{t(description)}</DialogDescription>
            ) : null}
          </DialogHeader>
          <div className="grid min-w-0 gap-3" data-testid="action-dialog-body">
            {children}
          </div>
          {errorText ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              <UiText>{errorText}</UiText>
            </div>
          ) : null}
          <DialogFooter>
            <Button
              disabled={isSubmitting}
              onClick={() => setOpen(false)}
              type="button"
              variant="outline"
            >{t("Cancel")}</Button>
            <Button disabled={isSubmitting || submitDisabled} type="submit">
              {isSubmitting ? t("Working...") : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function formatDialogError(error: unknown): string | null {
  if (error === null || error === undefined) {
    return null;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
