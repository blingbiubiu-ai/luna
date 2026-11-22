CREATE TABLE `shadow_heartbeats` (
  `shadow_id` text PRIMARY KEY NOT NULL REFERENCES `agent_shadows`(`id`),
  `agent_id` text NOT NULL REFERENCES `luna_agents`(`id`),
  `session_id` text NOT NULL,
  `cursor_at` integer NOT NULL DEFAULT 0,
  `covered_from` integer NOT NULL DEFAULT 0,
  `last_queued_at` integer NOT NULL DEFAULT 0,
  `command_id` text,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `schedule_failure_notifications` (
  `schedule_id` text PRIMARY KEY NOT NULL,
  `last_failed_occurrence_id` text NOT NULL,
  `last_failed_at` integer NOT NULL,
  `last_reason` text NOT NULL,
  `last_notified_at` integer,
  `notification_command_id` text,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `correlated_requests` (
  `id` text PRIMARY KEY NOT NULL,
  `kind` text NOT NULL,
  `agent_id` text NOT NULL REFERENCES `luna_agents`(`id`),
  `shadow_id` text NOT NULL REFERENCES `agent_shadows`(`id`),
  `origin_session_id` text NOT NULL,
  `origin_turn_id` text,
  `target_address` text NOT NULL,
  `target_session_id` text NOT NULL,
  `target_user_id` text,
  `outbound_command_id` text,
  `outbound_message_id` text,
  `instruction` text NOT NULL,
  `context_summary` text,
  `options_json` text,
  `hops` integer NOT NULL DEFAULT 3,
  `status` text NOT NULL,
  `result_json` text,
  `resolved_by_user_id` text,
  `return_command_id` text,
  `expires_at` integer,
  `created_by_invocation_id` text,
  `created_at` integer NOT NULL,
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `correlated_requests_shadow_status_idx` ON `correlated_requests` (`shadow_id`, `status`, `expires_at`);
--> statement-breakpoint
CREATE INDEX `correlated_requests_target_session_idx` ON `correlated_requests` (`target_session_id`, `status`);
--> statement-breakpoint
CREATE INDEX `correlated_requests_origin_session_idx` ON `correlated_requests` (`origin_session_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `correlated_requests_outbound_msg_idx` ON `correlated_requests` (`outbound_message_id`);
--> statement-breakpoint
CREATE INDEX `correlated_requests_outbound_cmd_idx` ON `correlated_requests` (`outbound_command_id`);
