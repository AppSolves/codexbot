-- Additive: no credential/session format changes or invalidation of existing requests.
ALTER TABLE requests ADD COLUMN progress_comment_id INTEGER;
ALTER TABLE requests ADD COLUMN progress_phase TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE requests ADD COLUMN progress_lease TEXT;
ALTER TABLE requests ADD COLUMN progress_until INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requests ADD COLUMN progress_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requests ADD COLUMN progress_next_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requests ADD COLUMN progress_hash TEXT;
ALTER TABLE requests ADD COLUMN progress_reported_stage TEXT;
ALTER TABLE requests ADD COLUMN progress_stage TEXT NOT NULL DEFAULT 'queued';
ALTER TABLE requests ADD COLUMN failure_code TEXT;
ALTER TABLE requests ADD COLUMN failure_stage TEXT;
ALTER TABLE requests ADD COLUMN failure_status INTEGER;
ALTER TABLE requests ADD COLUMN workflow_status TEXT;
ALTER TABLE requests ADD COLUMN workflow_conclusion TEXT;
ALTER TABLE requests ADD COLUMN workflow_checked_at INTEGER NOT NULL DEFAULT 0;
CREATE INDEX requests_progress_recovery ON requests(progress_next_at,progress_until,created_at);
