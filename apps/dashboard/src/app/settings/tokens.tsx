import { UiText } from "@/lib/i18n";
import { useTranslation } from "@/lib/i18n";
import { createFileRoute } from "@tanstack/react-router";
import { KeyRoundIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { CopyTextButton } from "@/components/copy-text-button";
import { Button } from "@/components/ui/button";
import { SelectField } from "@/components/ui/select-field";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  useAccessTokenCreateMutation,
  useAccessTokenRevokeMutation,
  useAccessTokens,
  type CreateAccessTokenInput,
  type CreatedAccessToken,
  type DashboardAccessToken,
} from "@/lib/api";

export const Route = createFileRoute("/$agentId/settings/tokens/")({
  component: AccessTokensPage,
});

function AccessTokensPage() {
  const tokens = useAccessTokens();
  const createToken = useAccessTokenCreateMutation();
  const revoke = useAccessTokenRevokeMutation();

  return (
    <AccessTokensView
      createError={createToken.error}
      creating={createToken.isPending}
      loading={tokens.isLoading}
      onCreate={(input) => createToken.mutateAsync(input)}
      onRevoke={(tokenId) => revoke.mutateAsync(tokenId)}
      tokens={tokens.data ?? []}
    />
  );
}

export function AccessTokensView({
  createError,
  creating = false,
  loading,
  onCreate,
  onRevoke,
  tokens,
}: {
  readonly createError?: unknown;
  readonly creating?: boolean;
  readonly loading?: boolean;
  readonly onCreate: (input: CreateAccessTokenInput) => Promise<CreatedAccessToken>;
  readonly onRevoke: (tokenId: string) => Promise<unknown>;
  readonly tokens: readonly DashboardAccessToken[];
}) {
  const { t } = useTranslation();
  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <KeyRoundIcon className="size-4" />
            <span>{t("Access Tokens")}</span>
          </div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("Tokens")}</h1>
          <p className="max-w-2xl text-sm text-muted-foreground">{t("CLI and MCP tokens identify the current dashboard user. Runtime permissions come from current user and group grants.")}</p>
        </div>
        <CreateAccessTokenDialog
          creating={creating}
          error={createError}
          onCreate={onCreate}
        />
      </header>

      <section className="overflow-hidden rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-muted-foreground">
            <tr>
              <th className="px-4 py-3 font-medium">{t("Name")}</th>
              <th className="px-4 py-3 font-medium">{t("Source")}</th>
              <th className="px-4 py-3 font-medium">{t("Role")}</th>
              <th className="px-4 py-3 font-medium">{t("Expires")}</th>
              <th className="px-4 py-3 text-right font-medium">{t("Actions")}</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="px-4 py-6 text-muted-foreground" colSpan={5}>{t("Loading tokens...")}</td>
              </tr>
            ) : tokens.length === 0 ? (
              <tr>
                <td className="px-4 py-6 text-muted-foreground" colSpan={5}>{t("No CLI or MCP tokens.")}</td>
              </tr>
            ) : (
              tokens.map((token) => (
                <tr className="border-t border-border" key={token.id}>
                  <td className="px-4 py-3">
                    <div className="font-medium">{token.name}</div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {token.id}
                    </div>
                  </td>
                  <td className="px-4 py-3 uppercase text-muted-foreground">
                    {token.source}
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    <UiText>{token.role}</UiText>
                  </td>
                  <td className="px-4 py-3 text-muted-foreground">
                    {formatTimestamp(token.expiresAt)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button
                      className="inline-flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-muted"
                      onClick={() => {
                        void onRevoke(token.id);
                      }}
                      type="button"
                    >
                      <Trash2Icon className="size-4" />{t("Revoke")}</button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}

function formatTimestamp(value: number): string {
  return new Date(value).toLocaleString();
}

const DAY_MS = 24 * 60 * 60 * 1000;
const TOKEN_EXPIRY_OPTIONS = [
  { label: "1 day", value: "1", days: 1 },
  { label: "7 days", value: "7", days: 7 },
  { label: "30 days", value: "30", days: 30 },
  { label: "90 days", value: "90", days: 90 },
  { label: "Custom", value: "custom", days: null },
] as const;

export function CreateAccessTokenDialog({
  createdToken: initialCreatedToken = null,
  creating = false,
  error,
  onCreate,
}: {
  readonly createdToken?: CreatedAccessToken | null;
  readonly creating?: boolean;
  readonly error?: unknown;
  readonly onCreate: (input: CreateAccessTokenInput) => Promise<CreatedAccessToken>;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(initialCreatedToken !== null);
  const [createdToken, setCreatedToken] = useState<CreatedAccessToken | null>(
    initialCreatedToken,
  );
  const [name, setName] = useState("Luna CLI");
  const [source, setSource] = useState<"cli" | "mcp">("cli");
  const [expiry, setExpiry] = useState("30");
  const [customDays, setCustomDays] = useState("30");
  const errorText = formatDialogError(error);
  const ttlMs = expiry === "custom"
    ? Math.max(1, Number(customDays) || 1) * DAY_MS
    : (TOKEN_EXPIRY_OPTIONS.find((option) => option.value === expiry)?.days ??
      30) * DAY_MS;

  async function handleSubmit() {
    const result = await onCreate({
      name: name.trim() || defaultTokenName(source),
      source,
      ttlMs,
    });
    setCreatedToken(result);
  }

  function handleOpenChange(nextOpen: boolean) {
    setOpen(nextOpen);
    if (!nextOpen) {
      setCreatedToken(null);
      setName(defaultTokenName(source));
      setExpiry("30");
      setCustomDays("30");
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button className="w-fit gap-2" type="button">
          <PlusIcon className="size-4" />{t("Create token")}</Button>
      </DialogTrigger>
      <DialogContent className="min-w-0 overflow-visible sm:max-w-2xl">
        <form
          className="grid min-w-0 gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (createdToken === null) {
              void handleSubmit().catch(() => undefined);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{t("Create token")}</DialogTitle>
            <DialogDescription>{t("Create an identity token for CLI or MCP access. Permissions are evaluated from current user and group grants.")}</DialogDescription>
          </DialogHeader>

          {createdToken ? (
            <CreatedTokenResult result={createdToken} />
          ) : (
            <div className="grid min-w-0 gap-4">
              <label className="grid gap-2 text-sm font-medium">{t("Name")}<input
                  className="h-10 rounded-md border border-input bg-background px-3 text-sm outline-none focus:border-ring"
                  onChange={(event) => setName(eventValue(event.currentTarget))}
                  value={name}
                />
              </label>
              <label className="grid gap-2 text-sm font-medium">{t("Source")}
                <SelectField
                  aria-label={t("Source")}
                  fullWidth
                  value={source}
                  onValueChange={(nextValue) => {
                    const nextSource = nextValue === "mcp" ? "mcp" : "cli";
                    setSource(nextSource);
                    setName(defaultTokenName(nextSource));
                  }}
                  options={[
                    { value: "cli", label: "CLI" },
                    { value: "mcp", label: "MCP" },
                  ]}
                />
              </label>
              <fieldset className="grid gap-2">
                <legend className="text-sm font-medium">{t("Expires after")}</legend>
                <div className="grid gap-2 sm:grid-cols-5">
                  {TOKEN_EXPIRY_OPTIONS.map((option) => (
                    <label
                      className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm"
                      key={option.value}
                    >
                      <input
                        checked={expiry === option.value}
                        name="token-expiry"
                        onChange={() => setExpiry(option.value)}
                        type="radio"
                        value={option.value}
                      />
                      <UiText>{t(option.label)}</UiText>
                    </label>
                  ))}
                </div>
              </fieldset>
              {expiry === "custom" ? (
                <label className="grid gap-2 text-sm font-medium">{t("Custom days")}<input
                    className="h-10 rounded-md border border-input bg-background px-3 text-sm outline-none focus:border-ring"
                    min={1}
                    onChange={(event) =>
                      setCustomDays(eventValue(event.currentTarget))}
                    type="number"
                    value={customDays}
                  />
                </label>
              ) : null}
            </div>
          )}

          {errorText ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
              <UiText>{errorText}</UiText>
            </div>
          ) : null}

          <DialogFooter>
            <Button
              onClick={() => handleOpenChange(false)}
              type="button"
              variant="outline"
            >
              {createdToken ? t("Close") : t("Cancel")}
            </Button>
            {createdToken === null ? (
              <Button disabled={creating} type="submit">
                {creating ? t("Creating...") : t("Create token")}
              </Button>
            ) : null}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function CreatedTokenResult({
  result,
}: {
  readonly result: CreatedAccessToken;
}) {
  const { t } = useTranslation();
  return (
    <div className="grid gap-3">
      <div className="rounded-md border border-amber-300/50 bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-950/30 dark:text-amber-200">{t("Only shown once. Copy it now and store it somewhere safe.")}</div>
      <div className="grid gap-2">
        <div className="text-sm font-medium">{t("Access token")}</div>
        <div className="flex min-w-0 items-center gap-2 rounded-md border border-border bg-muted/40 p-2">
          <code className="min-w-0 flex-1 truncate font-mono text-xs">
            {result.accessToken}
          </code>
          <CopyTextButton
            label={t("Copy access token")}
            text={result.accessToken}
          >{t("Copy access token")}</CopyTextButton>
        </div>
      </div>
      <div className="text-sm text-muted-foreground">{t("Expires")}{formatTimestamp(result.expiresAt)}
      </div>
    </div>
  );
}

function defaultTokenName(source: "cli" | "mcp"): string {
  return source === "mcp" ? "Luna MCP" : "Luna CLI";
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

function eventValue(target: unknown): string {
  return (target as { readonly value: string }).value;
}
