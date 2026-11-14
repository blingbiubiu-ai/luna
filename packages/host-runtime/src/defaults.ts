export const DEFAULT_LUNA_SERVICE_HOST = "127.0.0.1";
export const DEFAULT_LUNA_SERVICE_PORT = 8090;
export const DEFAULT_LUNA_DASHBOARD_TOKEN = "luna-local-dev";

/** Public development credentials must never protect a network listener. */
export function assertSafeDashboardBinding(host: string, token: string | undefined): void {
  const loopback = host === "127.0.0.1" || host === "::1";
  const configured = token?.trim();
  if (!loopback && (!configured || configured === DEFAULT_LUNA_DASHBOARD_TOKEN)) {
    throw new Error(
      "Set a unique LUNA_DASHBOARD_TOKEN before listening on a non-loopback address; the development token is only allowed on 127.0.0.1 or ::1",
    );
  }
}
