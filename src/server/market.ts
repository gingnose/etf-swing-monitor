import { AppError, type Bar, type Env } from './types.ts';

const symbols = ['SOXL', 'TQQQ'] as const;
const nyFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
export function nyDate(now: Date) { return nyFormatter.format(now); }

export function barsUrl(now: Date, feed: 'sip' | 'iex', page?: string, lookbackDays = 21, requestedSymbols: readonly string[] = symbols) {
  const url = new URL('https://data.alpaca.markets/v2/stocks/bars');
  // Exclude the current NY date entirely, even on early-close days. P1 is a
  // completed-daily-bars probe, not a real-time quote or a trading engine.
  const cutoff = new Date(`${nyDate(now)}T00:00:00.000Z`);
  url.search = new URLSearchParams({
    symbols: requestedSymbols.join(','), timeframe: '1Day', feed, adjustment: 'split', currency: 'USD',
    start: new Date(cutoff.getTime() - lookbackDays * 86400_000).toISOString(),
    end: new Date(cutoff.getTime() - 1).toISOString(), limit: lookbackDays > 21 ? '1000' : '100', sort: 'desc',
    ...(page ? { page_token: page } : {}),
  }).toString();
  return url;
}

export function parseBars(payload: unknown, feed: 'sip' | 'iex', now: Date): { bars: Bar[]; next: string | null } {
  if (!payload || typeof payload !== 'object' || !('bars' in payload)) throw new AppError(502, '価格データの形式を確認できません。');
  const data = payload as { bars: Record<string, unknown>; next_page_token?: unknown };
  if (!data.bars || typeof data.bars !== 'object') throw new AppError(502, '価格データが空です。');
  const result: Bar[] = [];
  const today = nyDate(now);

  for (const symbol of symbols) {
    const rows = data.bars[symbol];
    if (rows === undefined || rows === null) continue;
    if (!Array.isArray(rows)) throw new AppError(502, '価格データの形式を確認できません。');
    for (const row of rows) {
      if (!row || typeof row !== 'object') throw new AppError(502, '価格データが不正です。');
      const { t, c, v } = row;
      if (typeof t !== 'string' || !Number.isFinite(Date.parse(t)) || typeof c !== 'number' || !Number.isFinite(c) || c <= 0 ||
          typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new AppError(502, '価格または時刻を確認できません。');
      // Alpaca daily bars are stamped at NY midnight (04:00/05:00 UTC).
      // Compare their market-date prefix directly, avoiding per-row timezone formatting.
      if (!/^\d{4}-\d{2}-\d{2}T0[45]:00:00(?:\.000)?Z$/.test(t)) throw new AppError(502, '日足の基準時刻が不正です。');
      const marketDate = t.slice(0,10);
      if (marketDate >= today) continue;
      result.push({ symbol, close: c, volume: v, timestamp: t, feed });
    }
  }
  if (data.next_page_token != null && typeof data.next_page_token !== 'string') throw new AppError(502, '価格データのページ情報が不正です。');
  return { bars: result, next: data.next_page_token as string || null };
}

export async function fetchDailyBars(env: Pick<Env, 'ALPACA_API_KEY' | 'ALPACA_API_SECRET' | 'ALPACA_FEED'>, now = new Date(), fetcher: typeof fetch = fetch, lookbackDays = 21, requestedSymbols: readonly string[] = symbols): Promise<Bar[]> {
  if (!requestedSymbols.length || requestedSymbols.some(s => !['SOXL','TQQQ'].includes(s))) throw new AppError(400,'対象銘柄が不正です。');
  if (![21, 400].includes(lookbackDays)) throw new AppError(400, '取得期間が不正です。');
  if (!env.ALPACA_API_KEY || !env.ALPACA_API_SECRET) throw new AppError(503, 'AlpacaのAPIキーが未設定です。');
  if (env.ALPACA_FEED !== undefined && !['sip', 'iex'].includes(env.ALPACA_FEED)) throw new AppError(503, '価格データの取得元設定が不正です。');
  const feed = (env.ALPACA_FEED || 'sip') as 'sip' | 'iex';
  const all: Bar[] = [];
  let next: string | null = null;
  for (let page = 0; page < 4; page++) {
    let response: Response;
    try {
      response = await fetcher(barsUrl(now, feed, next || undefined, lookbackDays, requestedSymbols), {
        headers: { 'APCA-API-KEY-ID': env.ALPACA_API_KEY, 'APCA-API-SECRET-KEY': env.ALPACA_API_SECRET },
        signal: AbortSignal.timeout(12_000), redirect: 'manual',
      });
    } catch (error) {
      // Map runtime failures to fixed messages; never expose upstream errors or credentials.
      const message = error instanceof Error ? error.message : '';
      const reason = /illegal invocation|incorrect this/i.test(message) ? '実行環境の関数呼び出し'
        : /redirect/i.test(message) ? 'リダイレクト'
        : error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name) ? 'タイムアウト'
        : /invalid time|invalid date/i.test(message) ? '日付形式'
        : '通信';
      throw new AppError(502, `Alpacaへ接続できませんでした（${reason}）。時間をおいて再確認してください。`);
    }
    if (!response.ok) {
      if ([401, 403].includes(response.status)) throw new AppError(502, `Alpacaの認証・${feed.toUpperCase()}データ権限を確認してください。有料プランへ自動変更はしません。`);
      if (response.status === 429) throw new AppError(429, 'Alpacaの利用上限です。再試行を停止しました。');
      throw new AppError(502, `Alpacaで取得エラーが発生しました（HTTP ${response.status}）。`);
    }
    let payload: unknown;
    try { payload = await response.json(); } catch { throw new AppError(502, 'Alpacaの応答を読み取れませんでした。'); }
    const parsed = parseBars(payload, feed, now);
    all.push(...parsed.bars.filter(b=>requestedSymbols.includes(b.symbol)));
    next = parsed.next;
    if (!next) break;
  }
  if (next) throw new AppError(502, '取得ページ数の上限です。不完全なデータを採用しません。');
  const latest = requestedSymbols.map(symbol => all.filter(b => b.symbol === symbol).reduce<Bar | undefined>((a,b)=>!a || b.timestamp>a.timestamp ? b : a,undefined));
  if (latest.some(b => !b)) throw new AppError(502, 'SOXLとTQQQの両方の価格が揃っていません。');
  // A full exchange-calendar freshness check belongs to P2. This coarse bound
  // rejects grossly stale responses; always display the actual market timestamp.
  if (latest.some(b => !b || now.getTime() - Date.parse(b.timestamp) > 7 * 86400_000)) throw new AppError(502, '価格が古いため、取得成功として扱いません。');
  return all;
}
