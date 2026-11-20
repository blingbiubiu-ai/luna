ALTER TABLE `session_inbox` ADD `lane` text NOT NULL DEFAULT 'direct';
--> statement-breakpoint
ALTER TABLE `session_inbox` ADD `due_now` integer NOT NULL DEFAULT 0;
--> statement-breakpoint
CREATE TABLE `chat_listening` (
  `shadow_id` text NOT NULL,
  `chat_id` text NOT NULL,
  `enabled` integer,
  `silent_streak` integer NOT NULL DEFAULT 0,
  `updated_by_user_id` text,
  `updated_at` integer NOT NULL,
  PRIMARY KEY(`shadow_id`, `chat_id`)
);
