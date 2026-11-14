-- Additive migration. Old encrypted sessions cannot be rebound without the user's key.
-- Retain a short-lived quarantine for operator rollback; reconnect using installation-bound AAD v2.
ALTER TABLE sessions RENAME TO legacy_sessions;
CREATE TABLE sessions (
  installation_id INTEGER NOT NULL, repository_id INTEGER NOT NULL, actor_id INTEGER NOT NULL,
  envelope TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1, lease_request TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY(installation_id, repository_id, actor_id)
);
CREATE INDEX sessions_active_leases ON sessions(lease_until,lease_request) WHERE lease_request IS NOT NULL;
ALTER TABLE deliveries ADD COLUMN event TEXT;
ALTER TABLE deliveries ADD COLUMN payload TEXT;
ALTER TABLE deliveries ADD COLUMN request_id TEXT;
ALTER TABLE deliveries ADD COLUMN phase TEXT NOT NULL DEFAULT 'done';
ALTER TABLE deliveries ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deliveries ADD COLUMN lease TEXT;
ALTER TABLE deliveries ADD COLUMN lease_until INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deliveries ADD COLUMN next_attempt INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deliveries ADD COLUMN error_code TEXT;
ALTER TABLE deliveries ADD COLUMN operator_retries INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requests ADD COLUMN request_key TEXT;
ALTER TABLE requests ADD COLUMN rerun INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requests ADD COLUMN dispatch_attempt TEXT;
ALTER TABLE requests ADD COLUMN dispatch_phase TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE requests ADD COLUMN dispatch_started INTEGER;
ALTER TABLE requests ADD COLUMN prepare_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requests ADD COLUMN publish_phase TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE requests ADD COLUMN publish_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requests ADD COLUMN publish_lease TEXT;
ALTER TABLE requests ADD COLUMN publish_until INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requests ADD COLUMN next_publish INTEGER NOT NULL DEFAULT 0;
ALTER TABLE requests ADD COLUMN review_phase TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE requests ADD COLUMN merge_phase TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE requests ADD COLUMN operator_retries INTEGER NOT NULL DEFAULT 0;
CREATE UNIQUE INDEX requests_key ON requests(request_key);
CREATE INDEX deliveries_recovery ON deliveries(phase,next_attempt,lease_until);
CREATE INDEX requests_publication_recovery ON requests(state,next_publish,publish_until);
CREATE INDEX requests_merge_expiry ON requests(merge_phase,created_at,next_publish,publish_until);
CREATE INDEX requests_quota ON requests(installation_id,repository_id,actor_id,created_at);
-- Old workflows cannot prove the new attempt identity. Existing queued work must be re-requested.
UPDATE requests SET state='failed' WHERE state NOT IN ('published','failed');
