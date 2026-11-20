CREATE INDEX `sessions_parent_session_idx` ON `sessions` (`parent_session_id`);
--> statement-breakpoint
INSERT OR IGNORE INTO `sessions` (
  `id`,
  `agent_id`,
  `shadow_id`,
  `binding_id`,
  `surface_key`,
  `channel_type`,
  `channel_id`,
  `group_id`,
  `root_message_key`,
  `thread_key`,
  `parent_session_id`,
  `title`,
  `bot_user_id`,
  `status`,
  `kind`,
  `created_by_user_id`,
  `created_at`,
  `updated_at`,
  `last_activity_at`
)
SELECT
  lower(
    hex(randomblob(4)) || '-' ||
    hex(randomblob(2)) || '-4' ||
    substr(hex(randomblob(2)), 2) || '-' ||
    substr('89ab', abs(random()) % 4 + 1, 1) ||
    substr(hex(randomblob(2)), 2) || '-' ||
    hex(randomblob(6))
  ),
  g.`agent_id`,
  g.`shadow_id`,
  g.`binding_id`,
  json_array('v2', g.`binding_id`, g.`channel_type`, g.`channel_id`, g.`group_id`, 'channel', 'rootless'),
  g.`channel_type`,
  g.`channel_id`,
  g.`group_id`,
  NULL,
  NULL,
  NULL,
  NULL,
  (SELECT s.`reply_user_id` FROM `agent_shadows` s WHERE s.`id` = g.`shadow_id` AND s.`agent_id` = g.`agent_id`),
  'active',
  'main',
  NULL,
  g.`first_created_at`,
  g.`first_created_at`,
  g.`first_created_at`
FROM (
  SELECT
    t.`agent_id`,
    t.`shadow_id`,
    t.`binding_id`,
    t.`channel_type`,
    t.`channel_id`,
    t.`group_id`,
    MIN(t.`created_at`) AS `first_created_at`
  FROM `sessions` t
  WHERE t.`kind` = 'main'
    AND t.`status` != 'deleted'
    AND t.`channel_type` != 'dashboard'
    AND t.`binding_id` IS NOT NULL
    AND t.`group_id` IS NOT NULL
    AND t.`thread_key` IS NOT NULL
    AND t.`parent_session_id` IS NULL
    AND EXISTS (
      SELECT 1 FROM `agent_shadows` s
      WHERE s.`id` = t.`shadow_id`
        AND s.`agent_id` = t.`agent_id`
        AND s.`reply_user_id` IS NOT NULL
        AND EXISTS (SELECT 1 FROM `users` u WHERE u.`id` = s.`reply_user_id` AND u.`agent_id` = t.`agent_id`)
    )
    AND EXISTS (
      SELECT 1 FROM `shadow_bot_bindings` b
      WHERE b.`id` = t.`binding_id`
        AND b.`agent_id` = t.`agent_id`
        AND b.`shadow_id` = t.`shadow_id`
        AND b.`channel_config_id` = t.`channel_id`
    )
    AND NOT EXISTS (
      SELECT 1 FROM `sessions` p
      WHERE p.`kind` = 'main'
        AND p.`status` != 'deleted'
        AND p.`binding_id` = t.`binding_id`
        AND p.`channel_type` = t.`channel_type`
        AND p.`channel_id` = t.`channel_id`
        AND p.`group_id` = t.`group_id`
        AND p.`thread_key` IS NULL
    )
  GROUP BY t.`agent_id`, t.`shadow_id`, t.`binding_id`, t.`channel_type`, t.`channel_id`, t.`group_id`
) g;
--> statement-breakpoint
INSERT OR IGNORE INTO `session_surface_aliases` (`alias_key`, `session_id`, `created_at`)
SELECT p.`surface_key`, p.`id`, p.`created_at`
FROM `sessions` p
WHERE p.`kind` = 'main'
  AND p.`status` != 'deleted'
  AND p.`thread_key` IS NULL
  AND p.`surface_key` IS NOT NULL;
--> statement-breakpoint
INSERT OR IGNORE INTO `session_channel_bindings` (`id`, `session_id`, `channel_type`, `channel_id`, `surface_id`, `thread_id`, `root_message_id`)
SELECT
  'binding:' || p.`id` || ':' || p.`channel_id`,
  p.`id`,
  p.`channel_type`,
  p.`channel_id`,
  p.`group_id`,
  NULL,
  NULL
FROM `sessions` p
WHERE p.`kind` = 'main'
  AND p.`status` != 'deleted'
  AND p.`channel_type` != 'dashboard'
  AND p.`group_id` IS NOT NULL
  AND p.`thread_key` IS NULL;
--> statement-breakpoint
UPDATE `sessions`
SET `parent_session_id` = (
  SELECT p.`id`
  FROM `sessions` p
  WHERE p.`kind` = 'main'
    AND p.`status` != 'deleted'
    AND p.`binding_id` IS `sessions`.`binding_id`
    AND p.`channel_type` = `sessions`.`channel_type`
    AND p.`channel_id` = `sessions`.`channel_id`
    AND p.`group_id` = `sessions`.`group_id`
    AND p.`thread_key` IS NULL
    AND p.`id` != `sessions`.`id`
  ORDER BY (p.`root_message_key` IS NULL) DESC, p.`created_at` ASC, p.`id` ASC
  LIMIT 1
)
WHERE `kind` = 'main'
  AND `status` != 'deleted'
  AND `group_id` IS NOT NULL
  AND `thread_key` IS NOT NULL
  AND `parent_session_id` IS NULL;
