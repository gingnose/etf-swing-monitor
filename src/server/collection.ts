import { AppError, type Bar, type Env } from './types.ts';
import { fetchDailyBars, nyDate } from './market.ts';
import { cachedCalendar, validateCalendar } from './history.ts';
import { buildSnapshots, INDICATOR_VERSION, type Snapshot } from '../domain/indicators.ts';
import { digest } from './auth.ts';

export type CollectionResult = { ok: true; jobId: string; nextStage: 'continue' | 'publish' | null; detail: string };
/** Optional offline-test dependencies. Production callers omit this argument. */
export type CollectionDependencies = { clock?: () => Date; fetcher?: typeof fetch };
type Calendar = Awaited<ReturnType<typeof cachedCalendar>>;
type Part = { snapshot: Snapshot; latestBar: Bar };
type Job = {
  id: string; state: string; feed: 'sip' | 'iex'; requested_at: string;
  ny_date: string; expires_at: string; calendar_payload: string;
  soxl_payload: string; tqqq_payload: string | null;
};
const TTL = 30 * 60_000;
const clock = (deps: CollectionDependencies) => (deps.clock ?? (() => new Date()))();
const result = (id: string, nextStage: CollectionResult['nextStage']): CollectionResult => ({
  ok: true, jobId: id, nextStage,
  detail: nextStage ? '価格履歴を収集中です。次の処理で継続します。' : '価格履歴と参考指標を更新しました。売買判断は行いません。',
});
function assertLive(job: Pick<Job, 'requested_at' | 'expires_at' | 'ny_date'>, now: Date) {
  if (!Number.isFinite(now.getTime()) || now.getTime() < Date.parse(job.requested_at) ||
      now.getTime() >= Date.parse(job.expires_at) || nyDate(now) !== job.ny_date) {
    throw new AppError(409, '価格収集の有効期限またはNY日付が変わりました。最初から再取得してください。');
  }
}
function safeError(error: unknown) {
  return error instanceof AppError ? error : new AppError(503, '価格収集を完了できませんでした。保存済み履歴は保持しています。');
}
async function fail(env: Env, id: string, state: string | null, error: unknown, at: Date) {
  const safe = safeError(error);
  if (state === null) {
    await env.DB.prepare('INSERT OR IGNORE INTO runs(id,status,created_at,detail) VALUES (?,\'failed\',?,?)')
      .bind(id, at.toISOString(), safe.message).run();
  } else {
    await env.DB.batch([
      env.DB.prepare('UPDATE market_collection_jobs SET state=\'failed\',updated_at=?,detail=? WHERE id=? AND state=?')
        .bind(at.toISOString(), safe.message, id, state),
      env.DB.prepare(`INSERT OR IGNORE INTO runs(id,status,created_at,detail)
        SELECT id,'failed',?,? FROM market_collection_jobs WHERE id=? AND state='failed'`)
        .bind(at.toISOString(), safe.message, id),
    ]);
  }
  return safe;
}
async function claim(env: Env, id: string, from: string, to: string, now: Date): Promise<Job> {
  const job = await env.DB.prepare(`UPDATE market_collection_jobs SET state=?,updated_at=?
    WHERE id=? AND state=? RETURNING *`).bind(to, now.toISOString(), id, from).first<Job>();
  // A duplicate request must not fail a job owned by another invocation.
  if (!job) throw new AppError(409, 'この収集段階は実行済み、処理中、または存在しません。');
  try { assertLive(job, now); }
  catch (error) { throw await fail(env, id, to, error, now); }
  return job;
}
async function collectPart(env: Env, requested: Date, symbol: string, calendar: Calendar, deps: CollectionDependencies): Promise<Part> {
  const bars = await fetchDailyBars(env, requested, deps.fetcher ?? fetch, 1200, [symbol]);
  const snapshots = buildSnapshots(bars, clock(deps), [symbol]);
  if (snapshots.length !== 1 || snapshots[0].symbol !== symbol) throw new AppError(502, '価格履歴の銘柄が一致しません。');
  validateCalendar(snapshots, calendar);
  const snapshot = snapshots[0];
  const latestBar = bars.find(b => b.symbol === symbol && b.timestamp.slice(0, 10) === snapshot.asOf);
  if (!latestBar) throw new AppError(502, '最新の価格がありません。');
  return { snapshot, latestBar };
}

export async function collectStart(env: Env, now = new Date(), deps: CollectionDependencies = {}): Promise<CollectionResult> {
  const id = crypto.randomUUID();
  try {
    const calendar = await cachedCalendar(env, now);
    const part = await collectPart(env, now, 'SOXL', calendar, deps);
    const completed = clock(deps);
    const timing = { requested_at: now.toISOString(), expires_at: new Date(now.getTime() + TTL).toISOString(), ny_date: nyDate(now) };
    assertLive(timing, completed);
    await env.DB.prepare(`INSERT INTO market_collection_jobs
      (id,state,feed,requested_at,ny_date,expires_at,updated_at,calendar_payload,soxl_payload)
      VALUES (?,'pending',?,?,?,?,?,?,?)`)
      .bind(id, part.snapshot.feed, timing.requested_at, timing.ny_date, timing.expires_at,
        completed.toISOString(), JSON.stringify(calendar), JSON.stringify(part)).run();
    return result(id, 'continue');
  } catch (error) { throw await fail(env, id, null, error, clock(deps)); }
}

export async function collectContinue(env: Env, id: string, now = new Date(), deps: CollectionDependencies = {}): Promise<CollectionResult> {
  const job = await claim(env, id, 'pending', 'collecting', now);
  try {
    const calendar = JSON.parse(job.calendar_payload) as Calendar;
    // Pin the original feed and date window even if deployment configuration changed.
    const part = await collectPart({ ...env, ALPACA_FEED: job.feed }, new Date(job.requested_at), 'TQQQ', calendar, deps);
    const completed = clock(deps);
    assertLive(job, completed);
    const write = await env.DB.prepare(`UPDATE market_collection_jobs SET state='ready',tqqq_payload=?,updated_at=? WHERE id=? AND state='collecting'`)
      .bind(JSON.stringify(part), completed.toISOString(), id).run();
    if (write.meta.changes !== 1) throw new AppError(409, '収集ジョブの状態が変わりました。');
    return result(id, 'publish');
  } catch (error) { throw await fail(env, id, 'collecting', error, clock(deps)); }
}

export async function collectPublish(env: Env, id: string, now = new Date(), deps: CollectionDependencies = {}): Promise<CollectionResult> {
  const job = await claim(env, id, 'ready', 'publishing', now);
  try {
    const calendar = JSON.parse(job.calendar_payload) as Calendar;
    const parts = [JSON.parse(job.soxl_payload), JSON.parse(job.tqqq_payload!)] as Part[];
    const snapshots = parts.map(p => p.snapshot);
    if (snapshots.some((s, i) => s.symbol !== ['SOXL', 'TQQQ'][i] || s.feed !== job.feed || s.adjustment !== 'split') ||
        calendar.today !== job.ny_date || snapshots[0].asOf !== snapshots[1].asOf) throw new AppError(502, '収集履歴の整合性を確認できません。');
    validateCalendar(snapshots, calendar);
    const latestBars = parts.map(p => p.latestBar);
    if (parts.some(p => p.latestBar.symbol !== p.snapshot.symbol || p.latestBar.feed !== job.feed ||
        p.latestBar.timestamp.slice(0, 10) !== p.snapshot.asOf || p.latestBar.close !== p.snapshot.closes.at(-1)?.close)) throw new AppError(502, '最新価格と履歴が一致しません。');
    const inputHash = await digest(JSON.stringify(snapshots.map(s => ({ symbol: s.symbol, feed: s.feed, adjustment: s.adjustment, closes: s.closes }))));
    const completed = clock(deps);
    assertLive(job, completed);
    const completedAt = completed.toISOString();
    const payload = JSON.stringify({ version: INDICATOR_VERSION, snapshots, calendar, latestBars,
      source: 'Alpaca', currency: 'USD', lookbackDays: 1200, requestedAt: job.requested_at, fetchedAt: completedAt, collectionId: id });
    const detail = result(id, null).detail;
    const writes = await env.DB.batch([
      ...latestBars.map(b => env.DB.prepare(`INSERT INTO bars(symbol,timestamp,close,volume,feed,adjustment,received_at)
        VALUES (?,?,?,?,?,'split',?) ON CONFLICT(symbol,timestamp,feed) DO UPDATE SET
        close=excluded.close,volume=excluded.volume,received_at=excluded.received_at WHERE excluded.received_at > bars.received_at`)
        .bind(b.symbol, b.timestamp, b.close, b.volume, b.feed, job.requested_at)),
      env.DB.prepare(`INSERT INTO market_history(feed,requested_at,market_date,input_hash,payload) VALUES (?,?,?,?,?)
        ON CONFLICT(feed) DO UPDATE SET requested_at=excluded.requested_at,market_date=excluded.market_date,
        input_hash=excluded.input_hash,payload=excluded.payload WHERE excluded.requested_at > market_history.requested_at`)
        .bind(job.feed, job.requested_at, snapshots[0].asOf, inputHash, payload),
      env.DB.prepare('INSERT OR IGNORE INTO market_observations(feed,retrieved_at,market_date,input_hash,payload) VALUES (?,?,?,?,?)')
        .bind(job.feed, completedAt, snapshots[0].asOf, inputHash, payload),
      env.DB.prepare('INSERT INTO runs(id,status,created_at,detail) VALUES (?,\'success\',?,?)').bind(id, completedAt, detail),
      env.DB.prepare(`UPDATE market_collection_jobs SET state='done',updated_at=?,detail=? WHERE id=? AND state='publishing'`)
        .bind(completedAt, detail, id),
    ]);
    console.info('market-collection-publish', JSON.stringify({
      records: snapshots.reduce((total, s) => total + s.count, 0),
      rowsRead: writes.reduce((total, r) => total + (r.meta.rows_read ?? 0), 0),
      rowsWritten: writes.reduce((total, r) => total + (r.meta.rows_written ?? 0), 0),
      databaseBytes: writes.at(-1)?.meta.size_after,
    }));
    return result(id, null);
  } catch (error) { throw await fail(env, id, 'publishing', error, clock(deps)); }
}
