-- Ordering uses request start; availability timestamps inside snapshots and archives use completion.
ALTER TABLE market_history RENAME COLUMN retrieved_at TO requested_at;
