import * as React from "react";
import { Check, ChevronDown } from "lucide-react";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

export interface SelectFieldOption {
  readonly value: string;
  readonly label: React.ReactNode;
  readonly textLabel?: string;
  readonly disabled?: boolean;
}

export interface SelectFieldProps {
  readonly value: string;
  readonly options?: readonly SelectFieldOption[] | undefined;
  readonly children?: React.ReactNode;
  readonly onValueChange: (value: string) => void;
  readonly "aria-label"?: string | undefined;
  readonly placeholder?: string | undefined;
  readonly disabled?: boolean | undefined;
  readonly required?: boolean | undefined;
  readonly name?: string | undefined;
  readonly size?: "xs" | "sm" | "default" | undefined;
  readonly variant?: "outline" | "ghost" | undefined;
  readonly align?: "start" | "center" | "end" | undefined;
  readonly fullWidth?: boolean | undefined;
  readonly className?: string | undefined;
  readonly contentClassName?: string | undefined;
}

function normalizeOptions(
  options: readonly SelectFieldOption[] | undefined,
  children: React.ReactNode,
): SelectFieldOption[] {
  if (options) return [...options];
  const parsed: SelectFieldOption[] = [];
  React.Children.forEach(children, (child) => {
    if (
      React.isValidElement<{
        value?: string | number;
        disabled?: boolean;
        children?: React.ReactNode;
      }>(child) &&
      child.type === "option"
    ) {
      const val = String(child.props.value ?? "");
      parsed.push({
        value: val,
        label: child.props.children ?? val,
        disabled: child.props.disabled === true,
      });
    }
  });
  return parsed;
}

export function SelectField({
  value,
  options,
  children,
  onValueChange,
  "aria-label": ariaLabel,
  placeholder,
  disabled = false,
  required = false,
  name,
  size = "default",
  variant = "outline",
  align = "start",
  fullWidth = false,
  className,
  contentClassName,
}: SelectFieldProps) {
  const resolvedOptions = normalizeOptions(options, children);
  const isFullWidth = fullWidth || Boolean(className?.includes("w-full"));
  const selected =
    resolvedOptions.find((opt) => opt.value === value) ?? resolvedOptions[0];
  const displayLabel = selected ? selected.label : (placeholder ?? "");

  return (
    <span
      className={cn(
        "relative",
        isFullWidth ? "flex w-full min-w-0" : "inline-flex shrink-0",
      )}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={disabled}>
          <button
            type="button"
            aria-label={ariaLabel}
            disabled={disabled}
            className={cn(
              "inline-flex items-center justify-between gap-2 text-left font-normal whitespace-nowrap outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-50",
              isFullWidth ? "w-full min-w-0" : "w-auto",
              variant === "outline"
                ? "border border-border bg-card text-foreground shadow-2xs hover:bg-accent"
                : "border border-transparent bg-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
              size === "xs"
                ? "h-7 rounded-[7px] px-2 text-xs"
                : size === "sm"
                  ? "h-8 rounded-[8px] px-2.5 text-xs"
                  : "h-9 rounded-[8px] px-3 text-[13px]",
              className,
            )}
          >
            <span className="min-w-0 flex-1 truncate">{displayLabel}</span>
            <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align={align}
          className={cn(
            "max-h-72 min-w-[max(9rem,var(--radix-dropdown-menu-trigger-width))] rounded-[8px] border-border bg-card p-1 text-card-foreground shadow-lg",
            contentClassName,
          )}
        >
          {resolvedOptions.map((opt) => {
            const active = opt.value === value;
            return (
              <DropdownMenuItem
                key={opt.value}
                disabled={opt.disabled === true}
                onSelect={() => {
                  if (!opt.disabled) onValueChange(opt.value);
                }}
                className="flex cursor-pointer items-center justify-between gap-3 rounded-[6px] px-2.5 py-1.5 text-[13px]"
              >
                <span className="min-w-0 truncate">{opt.label}</span>
                {active ? (
                  <Check className="size-3.5 shrink-0 text-foreground" />
                ) : null}
              </DropdownMenuItem>
            );
          })}
        </DropdownMenuContent>
      </DropdownMenu>
      <select
        tabIndex={-1}
        aria-hidden="true"
        name={name}
        value={value}
        disabled={disabled}
        required={required}
        onChange={(event) => onValueChange(event.target.value)}
        className="pointer-events-none absolute inset-x-0 bottom-0 h-px w-full opacity-0"
      >
        {resolvedOptions.map((opt) => (
          <option key={opt.value} value={opt.value} disabled={opt.disabled}>
            {opt.textLabel ??
              (typeof opt.label === "string" || typeof opt.label === "number"
                ? opt.label
                : opt.value)}
          </option>
        ))}
      </select>
    </span>
  );
}
