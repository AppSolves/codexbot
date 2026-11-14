-- Additive: CLI sessions and request state remain unchanged.
CREATE TABLE web_transactions (
  state_hash TEXT PRIMARY KEY, browser_hash TEXT NOT NULL, kind TEXT NOT NULL,
  payload TEXT NOT NULL, expires_at INTEGER NOT NULL
);
CREATE INDEX web_transactions_expiry ON web_transactions(expires_at);
CREATE TABLE web_sessions (
  id_hash TEXT PRIMARY KEY, actor_id INTEGER NOT NULL, payload TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX web_sessions_actor ON web_sessions(actor_id);
CREATE INDEX web_sessions_expiry ON web_sessions(expires_at);
CREATE TABLE web_rate_limits (bucket TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL);
CREATE INDEX web_rate_limits_expiry ON web_rate_limits(expires_at);
CREATE TABLE web_connections (
  installation_id INTEGER NOT NULL, repository_id INTEGER NOT NULL, actor_id INTEGER NOT NULL,
  payload TEXT NOT NULL, state TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY(installation_id, repository_id, actor_id)
);
CREATE INDEX web_connections_actor ON web_connections(actor_id, updated_at DESC);
CREATE TABLE web_operations (
  installation_id INTEGER NOT NULL, repository_id INTEGER NOT NULL,
  lease TEXT NOT NULL, lease_until INTEGER NOT NULL,
  PRIMARY KEY(installation_id,repository_id)
);
CREATE INDEX web_operations_expiry ON web_operations(lease_until);
