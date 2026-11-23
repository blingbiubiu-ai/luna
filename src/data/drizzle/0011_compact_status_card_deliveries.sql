WITH `superseded_status_dispatches` AS (
  SELECT `id` FROM (
    SELECT
      r.`id`,
      ROW_NUMBER() OVER (
        PARTITION BY r.`session_id`, json_extract(r.`receipt`, '$.targetMessageId')
        ORDER BY r.`created_at` DESC, r.`id` DESC
      ) AS `rn`
    FROM `session_reply_dispatches` r
    WHERE r.`receipt` IS NOT NULL
      AND json_valid(r.`receipt`)
      AND json_extract(r.`receipt`, '$.replyMode') = 'update_status_card'
      AND json_extract(r.`receipt`, '$.targetMessageId') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM `session_channel_deliveries` d
        WHERE d.`dispatch_id` = r.`id` AND d.`status` NOT IN ('sent', 'skipped')
      )
  )
  WHERE `rn` > 1
)
DELETE FROM `session_channel_deliveries`
WHERE `dispatch_id` IN (SELECT `id` FROM `superseded_status_dispatches`);
--> statement-breakpoint
WITH `superseded_status_dispatches` AS (
  SELECT `id` FROM (
    SELECT
      r.`id`,
      ROW_NUMBER() OVER (
        PARTITION BY r.`session_id`, json_extract(r.`receipt`, '$.targetMessageId')
        ORDER BY r.`created_at` DESC, r.`id` DESC
      ) AS `rn`
    FROM `session_reply_dispatches` r
    WHERE r.`receipt` IS NOT NULL
      AND json_valid(r.`receipt`)
      AND json_extract(r.`receipt`, '$.replyMode') = 'update_status_card'
      AND json_extract(r.`receipt`, '$.targetMessageId') IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM `session_channel_deliveries` d
        WHERE d.`dispatch_id` = r.`id` AND d.`status` NOT IN ('sent', 'skipped')
      )
  )
  WHERE `rn` > 1
)
DELETE FROM `session_reply_dispatches`
WHERE `id` IN (SELECT `id` FROM `superseded_status_dispatches`);
--> statement-breakpoint
UPDATE `session_channel_deliveries`
SET
  `operation` = json_remove(`operation`, '$.nativeProgress', '$.progressUpdate', '$.statusCardSteps'),
  `receipt` = CASE
    WHEN `receipt` IS NOT NULL AND json_valid(`receipt`) AND json_type(`receipt`, '$.progressSnapshot') IS NULL
      THEN json_remove(`receipt`, '$.nativeProgress', '$.progressUpdate', '$.statusCardSteps')
    WHEN `receipt` IS NOT NULL AND json_valid(`receipt`)
      THEN json_remove(`receipt`, '$.nativeProgress', '$.progressUpdate')
    ELSE `receipt`
  END
WHERE `status` = 'sent'
  AND json_valid(`operation`)
  AND json_extract(`operation`, '$.replyMode') = 'update_status_card';
--> statement-breakpoint
UPDATE `session_reply_dispatches`
SET
  `signature` = CASE
    WHEN `signature` LIKE 'sha256:%' THEN `signature`
    ELSE 'legacy-compacted:' || `id`
  END,
  `receipt` = CASE
    WHEN json_type(`receipt`, '$.progressSnapshot') IS NULL
      THEN json_remove(`receipt`, '$.nativeProgress', '$.progressUpdate', '$.statusCardSteps')
    ELSE json_remove(`receipt`, '$.nativeProgress', '$.progressUpdate')
  END
WHERE `receipt` IS NOT NULL
  AND json_valid(`receipt`)
  AND json_extract(`receipt`, '$.replyMode') = 'update_status_card';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `session_reply_dispatches_session_idx` ON `session_reply_dispatches` (`session_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `session_channel_deliveries_receipt_id_idx` ON `session_channel_deliveries` (json_extract(`receipt`, '$.id'), `channel_id`, `updated_at`);
