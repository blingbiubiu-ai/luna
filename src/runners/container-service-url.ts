/**
 * Route the parent Luna service through Docker's host gateway and keep that
 * internal request out of configured HTTP proxies.
 */
export function rewriteLocalhostForContainer(env: Record<string, string>): Record<string, string> {
  const result = { ...env };
  const key = "LUNA_SERVICE_URL";
  if (result[key]) {
    try {
      const serviceUrl = new URL(result[key]);
      if (["127.0.0.1", "localhost", "0.0.0.0", "::", "[::1]"].includes(serviceUrl.hostname)) serviceUrl.hostname = "host.docker.internal";
      result[key] = serviceUrl.toString().replace(/\/$/, "");
    } catch {
      result[key] = result[key]
        .replace(/127\.0\.0\.1/g, "host.docker.internal")
        .replace(/localhost(?=[:\d])/g, "host.docker.internal");
    }
    const noProxy = appendNoProxyHost(
      result.NO_PROXY ?? result.no_proxy ?? "",
      "host.docker.internal",
    );
    result.NO_PROXY = noProxy;
    result.no_proxy = appendNoProxyHost(
      result.no_proxy ?? result.NO_PROXY ?? "",
      "host.docker.internal",
    );
  }
  return result;
}

function appendNoProxyHost(value: string, host: string): string {
  const entries = value.split(",").map((entry) => entry.trim()).filter(Boolean);
  if (!entries.includes(host)) {
    entries.push(host);
  }
  return entries.join(",");
}
