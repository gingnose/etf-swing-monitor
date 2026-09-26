CREATE TABLE news_alert_settings (id INTEGER PRIMARY KEY CHECK(id=1), enabled_at TEXT NOT NULL);
INSERT INTO news_alert_settings VALUES(1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
CREATE TABLE news_alerts (
 event_key TEXT PRIMARY KEY, article_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
 rule_version TEXT NOT NULL, created_at TEXT NOT NULL, status TEXT NOT NULL
 CHECK(status IN ('pending','claimed','accepted','failed','skipped')), detail TEXT
);
CREATE INDEX news_alerts_status ON news_alerts(status,created_at);
