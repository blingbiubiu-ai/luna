CREATE TABLE `account_identity_claims` (
	`account_id` text NOT NULL REFERENCES `accounts`(`id`) ON DELETE CASCADE,
	`identity_namespace` text NOT NULL,
	`identity_kind` text NOT NULL,
	`identity_value` text NOT NULL,
	`identity_scope` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`account_id`, `identity_namespace`, `identity_kind`, `identity_value`, `identity_scope`)
);
--> statement-breakpoint
CREATE INDEX `account_identity_claims_lookup_idx` ON `account_identity_claims` (`identity_namespace`, `identity_kind`, `identity_value`, `identity_scope`);
--> statement-breakpoint
UPDATE `accounts` SET `display_name` = 'Local dashboard user', `avatar_url` = NULL WHERE `id` = 'local-dashboard-user';
