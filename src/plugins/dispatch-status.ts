/** Shared HTTP mapping for direct operations and CLI proxy dispatch. */
export function operationDispatchStatus(errorCode: string): 400 | 403 | 404 | 409 | 500 {
  switch (errorCode) {
    case "operation_not_found":
    case "plugin_not_enabled":
      return 404;
    case "agent_plugin_disabled":
    case "plugin_scope_invalid":
    case "scope_mismatch":
    case "agent_access_denied":
    case "operation_not_granted":
    case "operation_subject_missing":
    case "host_permission_denied":
    case "token_inactive":
      return 403;
    case "plugin_scope_unsupported":
    case "plugin_config_changed":
    case "agent_disabled":
    case "shadow_disabled":
    case "invocation_inactive":
    case "invocation_scope_mismatch":
      return 409;
    case "agent_scope_required":
    case "invalid_input":
      return 400;
    default:
      return 500;
  }
}
