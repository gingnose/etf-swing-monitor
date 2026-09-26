export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  OWNER_TOKEN_HASH?: string;
  ALPACA_API_KEY?: string;
  ALPACA_API_SECRET?: string;
  ALPACA_FEED?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  ENABLE_SCHEDULED_CHECKS?: string;
}

export class AppError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

export type Bar = { symbol: string; close: number; volume: number; timestamp: string; feed: 'sip' | 'iex' };
