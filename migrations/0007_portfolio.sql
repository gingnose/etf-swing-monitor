-- Private owner ledger. No automatic deposits, broker connections or orders.
CREATE TABLE portfolio_state (
  id INTEGER PRIMARY KEY CHECK(id=1),
  revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0),
  payload TEXT,
  last_request_id TEXT,
  updated_at TEXT
);
INSERT INTO portfolio_state(id,revision) VALUES(1,0);
-- Never purge financial records with operational log retention.
CREATE TABLE portfolio_requests (
  request_id TEXT PRIMARY KEY,
  request_hash TEXT NOT NULL,
  applied_revision INTEGER NOT NULL UNIQUE,
  change_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
