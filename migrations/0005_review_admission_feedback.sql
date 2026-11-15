-- Durable outcomes contain identifiers and fixed policy metadata, never prompts or credentials.
CREATE TABLE review_rejections (
  id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE,
  installation_id INTEGER NOT NULL, repository_id INTEGER NOT NULL,
  identity TEXT NOT NULL, outcome TEXT NOT NULL,
  quota INTEGER, window_ms INTEGER, retry_at INTEGER,
  created_at INTEGER NOT NULL,
  phase TEXT NOT NULL DEFAULT 'pending' CHECK(phase IN ('pending','creating','done','failed')),
  comment_id INTEGER, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX review_rejections_due ON review_rejections(phase,next_attempt,lease_until);
CREATE INDEX review_rejections_tenant ON review_rejections(installation_id,repository_id);
