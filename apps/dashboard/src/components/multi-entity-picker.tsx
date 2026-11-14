import { UiText, useTranslation } from "@/lib/i18n";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";
import { CheckIcon, ChevronDownIcon, XIcon } from "lucide-react";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export interface MultiEntityPickerProps<TItem> {
  readonly dataTestId: string;
  readonly emptyText: string;
  readonly getItemId: (item: TItem) => string;
  readonly getItemTitle?: (item: TItem) => string;
  readonly items: readonly TItem[];
  readonly label: string;
  readonly onSelectedItemIdsChange: (itemIds: string[]) => void;
  readonly placeholder: string;
  readonly renderOption: (item: TItem) => ReactNode;
  readonly renderToken: (item: TItem) => ReactNode;
  readonly searchItems: (items: readonly TItem[], query: string) => readonly TItem[];
  readonly selectedItemIds: readonly string[];
}

export function MultiEntityPicker<TItem>({
  dataTestId,
  emptyText,
  getItemId,
  getItemTitle,
  items,
  label,
  onSelectedItemIdsChange,
  placeholder,
  renderOption,
  renderToken,
  searchItems,
  selectedItemIds,
}: MultiEntityPickerProps<TItem>) {
  const { t } = useTranslation();
  const [query, setQuery] = useState("");
  const [isOpen, setIsOpen] = useState(false);
  const selectedIdSet = useMemo(
    () => new Set(selectedItemIds),
    [selectedItemIds],
  );
  const selectedItems = items.filter((item) => selectedIdSet.has(getItemId(item)));
  const candidates = useMemo(
    () =>
      searchItems(items, query)
        .filter((item) => !selectedIdSet.has(getItemId(item)))
        .slice(0, 8),
    [getItemId, items, query, searchItems, selectedIdSet],
  );

  function removeItem(itemId: string) {
    onSelectedItemIdsChange(selectedItemIds.filter((id) => id !== itemId));
  }

  function addItem(itemId: string) {
    if (selectedIdSet.has(itemId)) {
      return;
    }
    onSelectedItemIdsChange([...selectedItemIds, itemId]);
  }

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
          data-testid="multi-entity-picker-control"
          onBlur={() => {
            setTimeout(() => setIsOpen(false), 120);
          }}
          onMouseDown={() => setIsOpen(true)}
          role="combobox"
          tabIndex={0}
        >
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
            {selectedItems.map((item) => {
              const itemId = getItemId(item);
              return (
                <span
                  className="inline-flex min-w-0 max-w-full items-center gap-2 overflow-hidden rounded-md border bg-muted/40 px-2 py-1 text-sm"
                  data-testid="multi-entity-picker-token"
                  key={itemId}
                  title={getItemTitle?.(item) ?? itemId}
                >
                  <span className="min-w-0 flex-1 overflow-hidden">
                    {renderToken(item)}
                  </span>
                  <button
                    aria-label={`Remove ${itemId}`}
                    className="ml-1 inline-flex size-4 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-background hover:text-foreground"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      removeItem(itemId);
                    }}
                    type="button"
                  >
                    <XIcon aria-hidden="true" className="size-3" />
                  </button>
                </span>
              );
            })}
            <Input
              aria-label={t(label)}
              autoComplete="off"
              className="h-7 min-w-24 flex-1 border-0 bg-transparent px-1 py-0 shadow-none focus-visible:ring-0"
              onBlur={() => {
                setTimeout(() => setIsOpen(false), 120);
              }}
              onChange={(event) => {
                setQuery(readInputValue(event.currentTarget));
                setIsOpen(true);
              }}
              onFocus={() => setIsOpen(true)}
              placeholder={selectedItems.length === 0 ? placeholder : ""}
              value={query}
            />
          </div>
          <ChevronDownIcon
            aria-hidden="true"
            className="ml-auto size-4 shrink-0 text-muted-foreground"
            data-testid="multi-entity-picker-chevron"
          />
        </div>
        {isOpen ? (
          <div className="absolute left-0 right-0 z-20 mt-1 max-h-64 min-w-0 overflow-auto rounded-md border bg-popover p-1 shadow-md">
            {candidates.length > 0 ? (
              candidates.map((item) => {
                const itemId = getItemId(item);
                return (
                  <button
                    className="flex w-full min-w-0 items-start gap-2 rounded-sm px-2 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                    key={itemId}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      addItem(itemId);
                      setQuery("");
                      setIsOpen(true);
                    }}
                    type="button"
                  >
                    <span className="mt-1 flex size-4 shrink-0 items-center justify-center rounded border text-transparent">
                      <CheckIcon aria-hidden="true" className="size-3" />
                    </span>
                    <span className="min-w-0 flex-1">{renderOption(item)}</span>
                  </button>
                );
              })
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
