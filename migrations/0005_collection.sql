-- Private, short-lived staging; only a complete pair may enter market_history.
CREATE TABLE market_collection_jobs (
  id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK(state IN ('pending','collecting','ready','publishing','done','failed')),
  feed TEXT NOT NULL CHECK(feed IN ('sip','iex')),
  requested_at TEXT NOT NULL,
  ny_date TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  calendar_payload TEXT NOT NULL,
  soxl_payload TEXT NOT NULL,
  tqqq_payload TEXT,
  detail TEXT,
  CHECK(state NOT IN ('ready','publishing','done') OR tqqq_payload IS NOT NULL)
);
CREATE INDEX market_collection_jobs_active ON market_collection_jobs(state, requested_at);
CREATE INDEX market_collection_jobs_expiry ON market_collection_jobs(expires_at);
