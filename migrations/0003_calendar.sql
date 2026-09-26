CREATE TABLE market_calendar (
  id INTEGER PRIMARY KEY CHECK(id=1),
  retrieved_at TEXT NOT NULL,
  payload TEXT NOT NULL
);
