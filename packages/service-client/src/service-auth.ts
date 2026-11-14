export interface ServiceAuthConfig {
  readonly accessToken?: string | undefined;
}

export function serviceAuthHeaders(
  config: ServiceAuthConfig,
  extra: Record<string, string> = {},
): Record<string, string> {
  return config.accessToken
    ? { ...extra, authorization: `Bearer ${config.accessToken}` }
    : extra;
}
