import { AppError, type Bar, type Env } from './types.ts';

const symbols = ['SOXL', 'TQQQ'] as const;
export function nyDate(now: Date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function barsUrl(now: Date, feed: 'sip' | 'iex', page?: string) {
  const url = new URL('https://data.alpaca.markets/v2/stocks/bars');
  // Exclude the current NY date entirely, even on early-close days. P1 is a
  // completed-daily-bars probe, not a real-time quote or a trading engine.
  const cutoff = new Date(`${nyDate(now)}T00:00:00.000Z`);
  url.search = new URLSearchParams({
    symbols: symbols.join(','), timeframe: '1Day', feed, adjustment: 'split', currency: 'USD',
    start: new Date(cutoff.getTime() - 21 * 86400_000).toISOString(),
    end: new Date(cutoff.getTime() - 1).toISOString(), limit: '100', sort: 'desc',
    ...(page ? { page_token: page } : {}),
  }).toString();
  return url;
}

export function parseBars(payload: unknown, feed: 'sip' | 'iex', now: Date): { bars: Bar[]; next: string | null } {
  if (!payload || typeof payload !== 'object' || !('bars' in payload)) throw new AppError(502, '価格データの形式を確認できません。');
  const data = payload as { bars: Record<string, unknown>; next_page_token?: unknown };
  if (!data.bars || typeof data.bars !== 'object') throw new AppError(502, '価格データが空です。');
  const result: Bar[] = [];
  for (const symbol of symbols) {
    const rows = data.bars[symbol];
    if (rows === undefined || rows === null) continue;
    if (!Array.isArray(rows)) throw new AppError(502, '価格データの形式を確認できません。');
    for (const row of rows) {
      if (!row || typeof row !== 'object') throw new AppError(502, '価格データが不正です。');
      const { t, c, v } = row;
      if (typeof t !== 'string' || !Number.isFinite(Date.parse(t)) || typeof c !== 'number' || !Number.isFinite(c) || c <= 0 ||
          typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new AppError(502, '価格または時刻を確認できません。');
      if (nyDate(new Date(t)) >= nyDate(now)) continue;
      result.push({ symbol, close: c, volume: v, timestamp: t, feed });
    }
  }
  if (data.next_page_token != null && typeof data.next_page_token !== 'string') throw new AppError(502, '価格データのページ情報が不正です。');
  return { bars: result, next: data.next_page_token as string || null };
}

export async function fetchDailyBars(env: Pick<Env, 'ALPACA_API_KEY' | 'ALPACA_API_SECRET' | 'ALPACA_FEED'>, now = new Date(), fetcher: typeof fetch = fetch): Promise<Bar[]> {
  if (!env.ALPACA_API_KEY || !env.ALPACA_API_SECRET) throw new AppError(503, 'AlpacaのAPIキーが未設定です。');
  if (env.ALPACA_FEED !== undefined && !['sip', 'iex'].includes(env.ALPACA_FEED)) throw new AppError(503, '価格データの取得元設定が不正です。');
  const feed = (env.ALPACA_FEED || 'sip') as 'sip' | 'iex';
  const all: Bar[] = [];
  let next: string | null = null;
  for (let page = 0; page < 4; page++) {
    let response: Response;
    try {
      response = await fetcher(barsUrl(now, feed, next || undefined), {
        headers: { 'APCA-API-KEY-ID': env.ALPACA_API_KEY, 'APCA-API-SECRET-KEY': env.ALPACA_API_SECRET },
        signal: AbortSignal.timeout(12_000), redirect: 'error',
      });
    } catch { throw new AppError(502, 'Alpacaへ接続できませんでした。時間をおいて再確認してください。'); }
    if (!response.ok) {
      if ([401, 403].includes(response.status)) throw new AppError(502, `Alpacaの認証・${feed.toUpperCase()}データ権限を確認してください。有料プランへ自動変更はしません。`);
      if (response.status === 429) throw new AppError(429, 'Alpacaの利用上限です。再試行を停止しました。');
      throw new AppError(502, `Alpacaで取得エラーが発生しました（HTTP ${response.status}）。`);
    }
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new AppError(502, 'Alpacaの応答を読み取れませんでした。'); }
    const parsed = parseBars(payload, feed, now);
    all.push(...parsed.bars);
    next = parsed.next;
    if (!next) break;
  }
  if (next) throw new AppError(502, '取得ページ数の上限です。不完全なデータを採用しません。');
  const latest = symbols.map(symbol => all.filter(b => b.symbol === symbol).sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0]);
  if (latest.some(b => !b)) throw new AppError(502, 'SOXLとTQQQの両方の価格が揃っていません。');
  // A full exchange-calendar freshness check belongs to P2. This coarse bound
  // rejects grossly stale responses; always display the actual market timestamp.
  if (latest.some(b => now.getTime() - Date.parse(b.timestamp) > 7 * 86400_000)) throw new AppError(502, '価格が古いため、取得成功として扱いません。');
  return all;
}

export async function runMarketCheck(env: Env, now = new Date()) {
  const id = crypto.randomUUID();
  try {
    const bars = await fetchDailyBars(env, now);
    const detail = 'SOXL・TQQQの日足を取得しました。売買判断はまだ行いません。';
    await env.DB.batch([
      ...bars.map(b => env.DB.prepare(`INSERT INTO bars(symbol,timestamp,close,volume,feed,adjustment,received_at)
        VALUES (?,?,?,?,?,'split',?) ON CONFLICT(symbol,timestamp,feed) DO UPDATE SET close=excluded.close,volume=excluded.volume,received_at=excluded.received_at`)
        .bind(b.symbol, b.timestamp, b.close, b.volume, b.feed, now.toISOString())),
      env.DB.prepare('INSERT INTO runs(id,status,created_at,detail) VALUES (?,?,?,?)').bind(id, 'success', now.toISOString(), detail),
    ]);
    return { ok: true, detail };
  } catch (error) {
    const detail = error instanceof AppError ? error.message : '取得処理を完了できませんでした。';
    await env.DB.prepare('INSERT INTO runs(id,status,created_at,detail) VALUES (?,?,?,?)')
      .bind(id, 'failed', now.toISOString(), detail).run();
    throw error instanceof AppError ? error : new AppError(503, detail);
  }
}
