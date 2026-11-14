import { ShieldCheckIcon } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { MultiEntityPicker } from "@/components/multi-entity-picker";
import { SingleEntityPicker } from "@/components/single-entity-picker";
import type { OperationPolicy } from "@/lib/api";

export function OperationPicker({
  operations,
  emptyText = "No matching operations",
  excludedOperationIds = [],
  label,
  onSelectedOperationChange,
  placeholder = "Search operations",
  selectedOperationId,
}: {
  readonly operations: readonly OperationPolicy[];
  readonly emptyText?: string;
  readonly excludedOperationIds?: readonly string[];
  readonly label: string;
  readonly onSelectedOperationChange: (operationId: string) => void;
  readonly placeholder?: string;
  readonly selectedOperationId: string;
}) {
  return (
    <SingleEntityPicker
      dataTestId="operation-picker"
      emptyText={emptyText}
      getItemId={(operation) => operation.id}
      getItemTitle={(operation) => operation.id}
      items={operations}
      label={label}
      onSelectedItemIdChange={onSelectedOperationChange}
      placeholder={placeholder}
      renderOption={(operation) => (
        <OperationOptionLabel operation={operation} />
      )}
      renderToken={(operation) => (
        <OperationTokenContent operation={operation} />
      )}
      searchItems={(items, query) =>
        filterOperationsForPicker(items, query, excludedOperationIds)}
      selectedItemId={selectedOperationId}
    />
  );
}

export function OperationMultiPicker({
  operations,
  emptyText = "No matching operations",
  excludedOperationIds = [],
  label,
  onSelectedOperationsChange,
  placeholder = "Search operations",
  selectedOperationIds,
}: {
  readonly operations: readonly OperationPolicy[];
  readonly emptyText?: string;
  readonly excludedOperationIds?: readonly string[];
  readonly label: string;
  readonly onSelectedOperationsChange: (operationIds: string[]) => void;
  readonly placeholder?: string;
  readonly selectedOperationIds: readonly string[];
}) {
  return (
    <MultiEntityPicker
      dataTestId="operation-picker"
      emptyText={emptyText}
      getItemId={(operation) => operation.id}
      getItemTitle={(operation) => operation.id}
      items={operations}
      label={label}
      onSelectedItemIdsChange={onSelectedOperationsChange}
      placeholder={placeholder}
      renderOption={(operation) => (
        <OperationOptionLabel operation={operation} />
      )}
      renderToken={(operation) => (
        <OperationTokenContent operation={operation} />
      )}
      searchItems={(items, query) =>
        filterOperationsForPicker(items, query, excludedOperationIds)}
      selectedItemIds={selectedOperationIds}
    />
  );
}

export function filterOperationsForPicker(
  operations: readonly OperationPolicy[],
  query: string,
  excludedOperationIds: readonly string[] = [],
): OperationPolicy[] {
  const normalizedQuery = query.trim().toLowerCase();
  const excludedSet = new Set(excludedOperationIds);
  return operations.filter((operation) => {
    if (excludedSet.has(operation.id)) {
      return false;
    }
    if (normalizedQuery.length === 0) {
      return true;
    }
    return [
      operation.id,
      operation.namespace,
      operation.operationKind,
      operation.riskLevel,
      operation.defaultDecision,
    ].join(" ").toLowerCase().includes(normalizedQuery);
  });
}

function OperationOptionLabel({
  operation,
}: {
  readonly operation: OperationPolicy;
}) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <span className="mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
        <ShieldCheckIcon aria-hidden="true" className="size-3" />
      </span>
      <div className="min-w-0">
        <div className="break-all font-mono text-xs font-medium">
          {operation.id}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>{operation.namespace}</span>
          <span>{operation.operationKind}</span>
          <RiskBadge riskLevel={operation.riskLevel} />
          <span>{operation.defaultDecision}</span>
        </div>
      </div>
    </div>
  );
}

function OperationTokenContent({
  operation,
}: {
  readonly operation: OperationPolicy;
}) {
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-2 overflow-hidden">
      <ShieldCheckIcon
        aria-hidden="true"
        className="size-4 shrink-0 text-muted-foreground"
      />
      <span className="min-w-0 truncate font-mono text-xs font-medium">
        {operation.id}
      </span>
      <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
        {operation.namespace}
      </span>
      <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
        {operation.operationKind}
      </span>
      <span className="hidden shrink-0 text-xs text-muted-foreground sm:inline">
        {operation.defaultDecision}
      </span>
      <RiskBadge riskLevel={operation.riskLevel} />
    </span>
  );
}

function RiskBadge({ riskLevel }: { readonly riskLevel: string }) {
  return (
    <Badge variant={riskLevel === "high" ? "destructive" : "outline"}>
      {riskLevel}
    </Badge>
  );
}
