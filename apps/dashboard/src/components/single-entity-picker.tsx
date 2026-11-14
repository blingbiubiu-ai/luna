import { UiText, useTranslation } from "@/lib/i18n";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { ChevronDownIcon, XIcon } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface SingleEntityPickerProps<TItem> {
  readonly dataTestId: string;
  readonly emptyText: string;
  readonly getItemId: (item: TItem) => string;
  readonly getItemTitle?: (item: TItem) => string;
  readonly items: readonly TItem[];
  readonly label: string;
  readonly onSelectedItemIdChange: (itemId: string) => void;
  readonly placeholder: string;
  readonly renderOption: (item: TItem) => ReactNode;
  readonly renderToken: (item: TItem) => ReactNode;
  readonly searchItems: (items: readonly TItem[], query: string) => readonly TItem[];
  readonly selectedItemId: string;
}

export function SingleEntityPicker<TItem>({
  dataTestId,
  emptyText,
  getItemId,
  getItemTitle,
  items,
  label,
  onSelectedItemIdChange,
  placeholder,
  renderOption,
  renderToken,
  searchItems,
  selectedItemId,
}: SingleEntityPickerProps<TItem>) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const selectedItem = items.find((item) => getItemId(item) === selectedItemId);
  const candidates = useMemo(
    () => searchItems(items, query).slice(0, 8),
    [items, query, searchItems],
  );

  return (
    <div className="grid min-w-0 gap-2" data-testid={dataTestId}>
      <label className="text-xs font-medium text-muted-foreground">
        {t(label)}
      </label>
      <div className="relative min-w-0">
        <div
          aria-expanded={isOpen}
          aria-label={t(label)}
          className={cn(
            "flex min-h-9 w-full min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-md border border-input bg-background px-2 py-1 shadow-xs transition-[color,box-shadow]",
            "focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50",
          )}
          data-testid="single-entity-picker-control"
          onBlur={() => {
            setTimeout(() => setIsOpen(false), 120);
          }}
          onMouseDown={() => setIsOpen(true)}
          role="combobox"
          tabIndex={0}
        >
          {selectedItem ? (
            <span
              className="inline-flex min-w-0 max-w-full flex-1 items-center gap-2 overflow-hidden rounded-md border bg-muted/40 px-2 py-1 text-sm"
              data-testid="single-entity-picker-token"
              title={getItemTitle?.(selectedItem) ?? getItemId(selectedItem)}
            >
              <span className="min-w-0 flex-1 overflow-hidden">
                {renderToken(selectedItem)}
              </span>
              <button
                aria-label={`Clear ${t(label)}`}
                className="ml-1 inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-background hover:text-foreground"
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onSelectedItemIdChange("");
                  setQuery("");
                }}
                type="button"
              >
                <XIcon aria-hidden="true" className="size-3" />
              </button>
            </span>
          ) : (
            <Input
              aria-label={t(label)}
              autoComplete="off"
              className="h-7 flex-1 border-0 bg-transparent px-1 py-0 shadow-none focus-visible:ring-0"
              onBlur={() => {
                setTimeout(() => setIsOpen(false), 120);
              }}
              onChange={(event) => {
                setQuery(readInputValue(event.currentTarget));
                setIsOpen(true);
              }}
              onFocus={() => setIsOpen(true)}
              placeholder={t(placeholder)}
              value={query}
            />
          )}
          <ChevronDownIcon
            aria-hidden="true"
            className="ml-auto size-4 shrink-0 text-muted-foreground"
            data-testid="single-entity-picker-chevron"
          />
        </div>
        {isOpen ? (
          <div className="absolute left-0 right-0 z-20 mt-1 max-h-64 min-w-0 overflow-auto rounded-md border bg-popover p-1 shadow-md">
            {candidates.length > 0 ? (
              candidates.map((item) => (
                <button
                  className="grid w-full min-w-0 gap-1 rounded-sm px-2 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                  key={getItemId(item)}
                  onMouseDown={(event) => {
                    event.preventDefault();
                    onSelectedItemIdChange(getItemId(item));
                    setQuery("");
                    setIsOpen(false);
                  }}
                  type="button"
                >
                  {renderOption(item)}
                </button>
              ))
            ) : (
              <div className="px-2 py-2 text-sm text-muted-foreground">
                <UiText>{emptyText}</UiText>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function readInputValue(target: EventTarget): string {
  return (target as { value?: string }).value ?? "";
}
