CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  auth_version TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE TABLE rate_limits (
  key TEXT PRIMARY KEY,
  count INTEGER NOT NULL DEFAULT 1,
  expires_at INTEGER NOT NULL
);
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  detail TEXT NOT NULL
);
CREATE INDEX runs_created_at ON runs(created_at);
CREATE TABLE bars (
  symbol TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  close REAL NOT NULL,
  volume REAL NOT NULL,
  feed TEXT NOT NULL,
  adjustment TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY(symbol, timestamp, feed)
);
CREATE TABLE push_subscription (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE notification_jobs (
  id TEXT PRIMARY KEY,
  due_at INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending', 'claimed', 'accepted', 'failed', 'skipped')),
  created_at TEXT NOT NULL,
  detail TEXT
);
CREATE TABLE daily_notifications (
  day TEXT PRIMARY KEY,
  job_id TEXT NOT NULL
);
CREATE TABLE scheduled_checks (
  slot TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
