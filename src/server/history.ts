import { AppError, type Env } from './types.ts';
import { nyDate } from './market.ts';
import { INDICATOR_VERSION, type Snapshot } from '../domain/indicators.ts';

type DataEnv = Pick<Env, 'ALPACA_API_KEY'|'ALPACA_API_SECRET'>;
export async function fetchCalendar(env: DataEnv, now: Date, fetcher: typeof fetch = fetch) {
  if (!env.ALPACA_API_KEY || !env.ALPACA_API_SECRET) throw new AppError(503, 'AlpacaのAPIキーが未設定です。');
  const today = nyDate(now);
  const base = Date.parse(today + 'T00:00:00Z');
  const start = new Date(base - 400 * 86400_000).toISOString().slice(0,10);
  const through = new Date(base + 14 * 86400_000).toISOString().slice(0,10);
  const url = new URL('https://paper-api.alpaca.markets/v2/calendar');
  url.search = new URLSearchParams({start,end:through}).toString();
  let response: Response;
  try { response = await fetcher(url, { headers: {'APCA-API-KEY-ID':env.ALPACA_API_KEY!, 'APCA-API-SECRET-KEY':env.ALPACA_API_SECRET!}, redirect:'manual', signal:AbortSignal.timeout(12000) }); }
  catch { throw new AppError(502, '取引日カレンダーへ接続できません。指標更新を保留します。'); }
  if (!response.ok) throw new AppError(502, `取引日カレンダーを取得できません（HTTP ${response.status}）。`);
  let data: unknown;
  try { data = await response.json(); } catch { throw new AppError(502, '取引日カレンダーの形式が不正です。'); }
  if (!Array.isArray(data) || data.length < 200 || data.length > 415) throw new AppError(502, '取引日カレンダーが不完全です。');
  const dates: string[] = data.map(row => row?.date);
  if (dates.some(d => typeof d !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d) || !Number.isFinite(Date.parse(d)) || new Date(d).toISOString().slice(0,10)!==d || d<start || d>through) || new Set(dates).size!==dates.length) throw new AppError(502, '取引日カレンダーが不正です。');
  dates.sort();
  if (dates.at(-1)! < new Date(base + 7 * 86400_000).toISOString().slice(0,10)) throw new AppError(502, '取引日カレンダーの将来分が不足しています。');
  return { dates, through: dates.at(-1)!, start, today };
}
export async function refreshCalendar(env: Env, now = new Date()) {
  const calendar = await fetchCalendar(env, now);
  await env.DB.prepare(`INSERT INTO market_calendar(id,retrieved_at,payload) VALUES (1,?,?)
    ON CONFLICT(id) DO UPDATE SET retrieved_at=excluded.retrieved_at,payload=excluded.payload
    WHERE excluded.retrieved_at >= market_calendar.retrieved_at`).bind(now.toISOString(),JSON.stringify(calendar)).run();
  return {ok:true,detail:'取引日カレンダーを更新しました。'};
}
export async function cachedCalendar(env: Env, now: Date) {
  const row = await env.DB.prepare('SELECT payload FROM market_calendar WHERE id=1').first<{payload:string}>();
  if (!row) throw new AppError(503, '取引日カレンダーの更新が必要です。');
  const calendar = JSON.parse(row.payload) as Awaited<ReturnType<typeof fetchCalendar>>;
  if (calendar.today !== nyDate(now)) throw new AppError(503, '取引日カレンダーが古いため更新が必要です。');
  return calendar;
}
export function validateCalendar(snapshots: Snapshot[], calendar: {dates:string[];today:string}) {
  const expected = calendar.dates.filter(d=>d<calendar.today);
  if (snapshots.some(s=>JSON.stringify(s.closes.map(b=>b.date))!==JSON.stringify(expected))) throw new AppError(502, '取引日と価格履歴が一致しません。欠損を補完せず指標更新を保留します。');
}
export async function readResearch(env: Env, now = new Date()) {
  const row = await env.DB.prepare(`SELECT payload,input_hash AS inputHash,
    (SELECT status FROM runs ORDER BY created_at DESC LIMIT 1) AS latestStatus
    FROM market_history WHERE feed=?`).bind(env.ALPACA_FEED || 'sip').first<{payload:string;inputHash:string;latestStatus:string}>();
  const empty = {version:INDICATOR_VERSION,snapshots:[],latestBars:[]};
  if (!row) return {...empty,state:'unavailable' as const,detail:'価格履歴はまだ取得していません。「データ取得を確認」で更新できます。'};
  if (row.latestStatus !== 'success') return {...empty,state:'unavailable' as const,detail:'直近の取得に失敗しました。保存済み履歴は保持し、参考指標の表示を保留しています。'};
  const payload = JSON.parse(row.payload);
  const today = nyDate(now);
  const expected = payload.calendar.dates.filter((d:string)=>d<today).at(-1);
  if (today>payload.calendar.through || payload.snapshots.some((s:Snapshot)=>s.asOf!==expected)) return {...empty,state:'stale' as const,detail:'最新の確定取引日までの価格がありません。指標の表示を保留しています。'};
  return {...payload,state:'available' as const,inputHash:row.inputHash,detail:'確定済み日足から計算した参考値です。買い時や上昇確率を示すものではありません。'};
}
