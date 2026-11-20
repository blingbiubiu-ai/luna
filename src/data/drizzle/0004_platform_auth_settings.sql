CREATE TABLE `platform_auth_settings` (
  `provider` text PRIMARY KEY NOT NULL,
  `enabled` integer NOT NULL DEFAULT 1,
  `app_id` text NOT NULL,
  `secret` text NOT NULL,
  `feishu_host` text NOT NULL DEFAULT 'https://open.feishu.cn',
  `public_base_url` text NOT NULL DEFAULT '',
  `updated_by_account_id` text NOT NULL REFERENCES accounts(id),
  `updated_at` integer NOT NULL
);
