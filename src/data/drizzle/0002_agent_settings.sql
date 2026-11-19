CREATE TABLE `agent_settings` (
  `agent_id` text PRIMARY KEY NOT NULL REFERENCES luna_agents(id),
  `settings` text NOT NULL,
  `updated_by_account_id` text NOT NULL REFERENCES accounts(id),
  `updated_at` integer NOT NULL
);
