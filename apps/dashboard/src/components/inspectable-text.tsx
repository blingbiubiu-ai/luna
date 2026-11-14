import { useTranslation } from "@/lib/i18n";
import { CopyTextButton } from "@/components/copy-text-button";
import { cn } from "@/lib/utils";

export interface InspectableTextProps {
  readonly text: string;
  readonly label: string;
  readonly previewLength?: number;
  readonly className?: string;
  readonly previewClassName?: string;
  readonly popoverClassName?: string;
}

export function InspectableText({
  text,
  label,
  previewLength = 160,
  className,
  previewClassName,
  popoverClassName,
}: InspectableTextProps) {
  const { t } = useTranslation();
  const preview = truncateInspectableText(text, previewLength);
  const isTruncated = preview !== text;

  if (!isTruncated) {
    return (
      <span className={cn("break-words", className)} title={text}>
        {text}
      </span>
    );
  }

  const copyLabel = `Copy full ${label}`;

  return (
    <span
      className={cn("group/inspectable relative block max-w-full", className)}
    >
      <span
        className={cn("break-words", previewClassName)}
        data-testid="inspectable-text-preview"
      >
        {preview}
      </span>
      <span
        className={cn(
          "invisible absolute left-0 top-full z-50 mt-1 w-[min(34rem,calc(100vw-2rem))] rounded-md border bg-popover p-3 text-popover-foreground opacity-0 shadow-md transition-opacity group-hover/inspectable:visible group-hover/inspectable:opacity-100 group-focus-within/inspectable:visible group-focus-within/inspectable:opacity-100",
          popoverClassName,
        )}
        data-testid="inspectable-text-popover"
        role="tooltip"
      >
        <span className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-medium text-muted-foreground">{t("Full")}{label}
          </span>
          <CopyTextButton
            className="h-6 px-2 text-xs"
            label={copyLabel}
            text={text}
          />
        </span>
        <span className="block max-h-72 overflow-auto whitespace-pre-wrap break-words text-xs leading-5">
          {text}
        </span>
      </span>
    </span>
  );
}

function truncateInspectableText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  const safeLength = Math.max(1, maxLength - 3);
  return `${text.slice(0, safeLength)}...`;
}
