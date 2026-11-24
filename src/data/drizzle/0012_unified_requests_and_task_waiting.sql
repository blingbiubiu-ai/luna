ALTER TABLE `correlated_requests` ADD COLUMN `mode` text NOT NULL DEFAULT 'delegate';
--> statement-breakpoint
ALTER TABLE `correlated_requests` ADD COLUMN `origin_task_id` text;
--> statement-breakpoint
ALTER TABLE `correlated_requests` ADD COLUMN `origin_task_run_id` text;
--> statement-breakpoint
UPDATE `correlated_requests`
SET `mode` = CASE
  WHEN `kind` = 'ask' AND `options_json` IS NOT NULL AND `options_json` != 'null' THEN 'card'
  ELSE 'delegate'
END;
--> statement-breakpoint
UPDATE `correlated_requests` SET `kind` = 'request';
--> statement-breakpoint
UPDATE `correlated_requests` SET `status` = 'open' WHERE `status` = 'pending';
--> statement-breakpoint
UPDATE `correlated_requests` SET `status` = 'done' WHERE `status` = 'answered';
--> statement-breakpoint
CREATE INDEX `correlated_requests_origin_task_idx` ON `correlated_requests` (`origin_task_id`, `status`);
--> statement-breakpoint
CREATE TABLE `correlated_request_events` (
  `id` text PRIMARY KEY NOT NULL,
  `request_id` text NOT NULL REFERENCES `correlated_requests`(`id`) ON DELETE CASCADE,
  `seq` integer NOT NULL,
  `direction` text NOT NULL,
  `kind` text NOT NULL,
  `content` text NOT NULL,
  `metadata_json` text,
  `actor_user_id` text,
  `command_id` text,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `correlated_request_events_req_seq_unique` ON `correlated_request_events` (`request_id`, `seq`);
--> statement-breakpoint
CREATE INDEX `correlated_request_events_req_created_idx` ON `correlated_request_events` (`request_id`, `created_at`);
--> statement-breakpoint
ALTER TABLE `tasks` ADD COLUMN `wake_at` integer;
--> statement-breakpoint
ALTER TABLE `tasks` ADD COLUMN `wake_reason` text;
--> statement-breakpoint
CREATE INDEX `tasks_wake_at_idx` ON `tasks` (`status`, `wake_at`);
--> statement-breakpoint
ALTER TABLE `task_runs` ADD COLUMN `pause_reason` text;
--> statement-breakpoint
CREATE TABLE `task_inbox_events` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL REFERENCES `tasks`(`id`) ON DELETE CASCADE,
  `seq` integer NOT NULL,
  `kind` text NOT NULL,
  `source` text NOT NULL,
  `correlation_id` text,
  `content` text NOT NULL,
  `payload_json` text,
  `delivered_context_id` text,
  `delivered_run_id` text,
  `delivered_at` integer,
  `created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `task_inbox_events_task_seq_unique` ON `task_inbox_events` (`task_id`, `seq`);
--> statement-breakpoint
CREATE INDEX `task_inbox_events_pending_idx` ON `task_inbox_events` (`task_id`, `delivered_context_id`, `seq`);
