import { UiText } from "@/lib/i18n";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { copyTextToClipboard } from "@/lib/clipboard";

export interface CopyTextButtonProps {
  readonly text: string;
  readonly label: string;
  readonly children?: ReactNode;
  readonly className?: string;
  readonly title?: string;
}

export function CopyTextButton({
  text,
  label,
  children,
  className,
  title,
}: CopyTextButtonProps) {
  const [copied, setCopied] = useState(false);
  const Icon = copied ? CheckIcon : CopyIcon;

  async function copyText(): Promise<void> {
    if (await copyTextToClipboard(text)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }
  }

  return (
    <Button
      aria-label={label}
      className={className}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void copyText();
      }}
      size="xs"
      title={title}
      type="button"
      variant="outline"
    >
      <Icon aria-hidden="true" className="size-3" />
      <UiText>{children ?? label}</UiText>
    </Button>
  );
}
