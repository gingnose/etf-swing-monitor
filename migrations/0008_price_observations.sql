-- Immutable first observation per rule version and completed market date.
CREATE TABLE price_rule_observations (
 version TEXT NOT NULL,
 market_date TEXT NOT NULL,
 observed_at TEXT NOT NULL,
 input_hash TEXT NOT NULL,
 payload TEXT NOT NULL,
 PRIMARY KEY(version,market_date)
);
-- Owner-only aggregate retrospective results, uploaded separately from public code.
CREATE TABLE price_rule_evaluations (
 version TEXT PRIMARY KEY,
 created_at TEXT NOT NULL,
 payload TEXT NOT NULL
);
