CREATE TABLE news_items (
 id TEXT PRIMARY KEY, source TEXT NOT NULL, url TEXT NOT NULL,
 title TEXT NOT NULL, published_at TEXT NOT NULL, updated_at TEXT,
 first_seen TEXT NOT NULL, last_seen TEXT NOT NULL, request_at TEXT NOT NULL,
 fingerprint TEXT NOT NULL, headline_key TEXT NOT NULL, evidence TEXT NOT NULL
);
CREATE INDEX news_items_recent ON news_items(published_at DESC);
CREATE INDEX news_items_seen ON news_items(last_seen);
CREATE TABLE news_revisions (
 id TEXT NOT NULL, fingerprint TEXT NOT NULL, observed_at TEXT NOT NULL,
 title TEXT NOT NULL, published_at TEXT NOT NULL, updated_at TEXT, evidence TEXT NOT NULL, symbols TEXT NOT NULL,
 PRIMARY KEY(id,fingerprint)
);
CREATE INDEX news_revisions_observed ON news_revisions(observed_at);
CREATE TABLE news_sources (
 source TEXT PRIMARY KEY, attempted_at TEXT NOT NULL, success_at TEXT,
 status TEXT NOT NULL, detail TEXT NOT NULL, limited INTEGER NOT NULL,
 accepted INTEGER NOT NULL, rejected INTEGER NOT NULL
);
