CREATE TABLE deliveries (id TEXT PRIMARY KEY, digest TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
CREATE INDEX deliveries_created ON deliveries(created_at);
CREATE TABLE requests (
  id TEXT PRIMARY KEY, installation_id INTEGER NOT NULL, repository_id INTEGER NOT NULL, actor_id INTEGER NOT NULL,
  snapshot TEXT NOT NULL, run_id TEXT,
  state TEXT NOT NULL DEFAULT 'created' CHECK(state IN ('created','dispatched','running','reviewed','publishing','published','failed')),
  review_id INTEGER, result TEXT, context_complete INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
);
CREATE INDEX requests_installation ON requests(installation_id);
CREATE INDEX requests_created ON requests(created_at);
CREATE TABLE sessions (
  repository_id INTEGER NOT NULL, actor_id INTEGER NOT NULL, installation_id INTEGER NOT NULL, envelope TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  lease_request TEXT, lease_until INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(repository_id, actor_id)
);
