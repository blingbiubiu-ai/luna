ALTER TABLE timeline_events ADD COLUMN task_run_id text;
--> statement-breakpoint
ALTER TABLE timeline_events ADD COLUMN updated_at integer NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE timeline_events SET updated_at = created_at, task_run_id = json_extract(
  CASE WHEN json_valid(data) THEN CASE WHEN json_type(data) = 'text' AND json_valid(json_extract(data, '$')) THEN json_extract(data, '$') ELSE data END ELSE '{}' END, '$.taskRunId');
--> statement-breakpoint
CREATE INDEX timeline_task_run_created_idx ON timeline_events(task_id, task_run_id, created_at, id);
--> statement-breakpoint
CREATE INDEX timeline_task_run_updated_idx ON timeline_events(task_id, task_run_id, updated_at, id);
