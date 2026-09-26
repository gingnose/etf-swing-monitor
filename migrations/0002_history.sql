-- Coherent, split-adjusted rolling windows; never append incompatible split bases.
CREATE TABLE market_history (
  feed TEXT PRIMARY KEY CHECK(feed IN ('sip','iex')),
  retrieved_at TEXT NOT NULL,
  market_date TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  payload TEXT NOT NULL
);
-- First observation for each market date is immutable; not a historical backtest.
CREATE TABLE market_observations (
  feed TEXT NOT NULL,
  market_date TEXT NOT NULL,
  retrieved_at TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY(feed,market_date)
);
CREATE INDEX market_observations_retention ON market_observations(retrieved_at);
