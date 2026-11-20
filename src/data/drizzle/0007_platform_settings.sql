CREATE TABLE `platform_settings` (
  `id` text PRIMARY KEY NOT NULL CHECK (`id` = 'default'),
  `settings` text NOT NULL,
  `updated_by_account_id` text REFERENCES `accounts`(`id`),
  `updated_at` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `platform_settings` (`id`, `settings`, `updated_by_account_id`, `updated_at`)
SELECT
  'default',
  json_object('general', json_object('publicBaseUrl', trim(`public_base_url`))),
  `updated_by_account_id`,
  `updated_at`
FROM `platform_auth_settings`
WHERE `provider` = 'feishu' AND trim(`public_base_url`) <> '';
