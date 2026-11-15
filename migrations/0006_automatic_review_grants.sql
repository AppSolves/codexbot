-- Explicit administrator consent; no tokens, keys or sessions are copied.
CREATE TABLE automatic_review_grants (
  installation_id INTEGER NOT NULL, repository_id INTEGER NOT NULL,
  id TEXT NOT NULL UNIQUE, actor_id INTEGER NOT NULL, actor TEXT NOT NULL,
  credential_mode TEXT NOT NULL CHECK(credential_mode IN ('chatgpt','api-key')),
  granted_at INTEGER NOT NULL,
  PRIMARY KEY(installation_id,repository_id)
);
