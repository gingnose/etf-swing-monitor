import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { collectStart, collectContinue, collectPublish, type CollectionDependencies } from '../src/server/collection.ts';
import type { Env } from '../src/server/types.ts';

// Execute the real migration/SQL against SQLite, with D1's atomic batch contract.
function fixture() {
  const db = new DatabaseSync(':memory:');
  for (const file of ['0001_validation.sql', '0002_history.sql', '0003_calendar.sql', '0004_history_timing.sql', '0005_collection.sql']) {
    db.exec(readFileSync(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  }
  const now = new Date('2026-09-26T12:00:00Z');
  let time = new Date(now);
  let price = 100;
  let broken = false;
  const requests: URL[] = [];
  const dates = ['2026-09-23', '2026-09-24', '2026-09-25'];
  const calendar = { dates: [...dates, '2026-09-28'], start: '2025-08-22', today: '2026-09-26', through: '2026-10-09' };
  db.prepare('INSERT INTO market_calendar VALUES (1,?,?)').run(now.toISOString(), JSON.stringify(calendar));
  function prepare(sql: string) {
    let args: (string | number | null)[] = [];
    const statement = {
      bind(...values: (string | number | null)[]) { args = values; return statement; },
      async first() { return db.prepare(sql).get(...args) ?? null; },
      execute() { const r = db.prepare(sql).run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
      async run() { return statement.execute(); },
    };
    return statement;
  }
  const env = { ALPACA_API_KEY: 'fixture', ALPACA_API_SECRET: 'fixture', ALPACA_FEED: 'sip', DB: {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      db.exec('BEGIN');
      try { const results = statements.map(s => s.execute()); db.exec('COMMIT'); return results; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  } } as unknown as Env;
  const deps: CollectionDependencies = {
    clock: () => new Date(time),
    fetcher: (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      requests.push(url);
      if (broken) return new Response('upstream-private-detail', { status: 500 });
      const symbol = url.searchParams.get('symbols')!;
      assert.ok(['SOXL', 'TQQQ'].includes(symbol));
      return Response.json({ bars: { [symbol]: dates.map((d, i) => ({ t: d + 'T04:00:00Z', c: price + i, v: 1000 })) } });
    }) as typeof fetch,
  };
  const one = (sql: string) => db.prepare(sql).get()!;
  return { db, env, deps, now, requests, one,
    time: (value: Date) => { time = value; }, price: (value: number) => { price = value; }, broken: () => { broken = true; } };
}

test('three stages publish a complete pair, completion timestamps, and one immutable observation', async t => {
  const f = fixture(); t.after(() => f.db.close());
  f.time(new Date(f.now.getTime() + 500));
  const a = await collectStart(f.env, f.now, f.deps);
  assert.equal(a.nextStage, 'continue');
  assert.equal(f.one('SELECT count(*) AS n FROM market_history').n, 0);
  f.time(new Date(f.now.getTime() + 1000));
  const b = await collectContinue(f.env, a.jobId, new Date(f.now.getTime() + 1000), f.deps);
  assert.equal(b.nextStage, 'publish');
  assert.equal(f.one('SELECT count(*) AS n FROM market_history').n, 0);
  f.time(new Date(f.now.getTime() + 2000));
  assert.equal((await collectPublish(f.env, a.jobId, new Date(f.now.getTime() + 2000), f.deps)).nextStage, null);
  assert.deepEqual(f.requests.map(u => u.searchParams.get('symbols')), ['SOXL', 'TQQQ']);
  assert.equal(f.requests[0].searchParams.get('start'), f.requests[1].searchParams.get('start'));
  const saved = f.one('SELECT * FROM market_history');
  const payload = JSON.parse(saved.payload as string);
  assert.deepEqual(payload.snapshots.map((s: { symbol: string }) => s.symbol), ['SOXL', 'TQQQ']);
  assert.deepEqual(payload.snapshots.map((s: { retrievedAt: string }) => s.retrievedAt),
    ['2026-09-26T12:00:00.500Z', '2026-09-26T12:00:01.000Z']);
  assert.equal(payload.fetchedAt, '2026-09-26T12:00:02.000Z');
  assert.equal(saved.requested_at, f.now.toISOString());
  assert.equal(f.one('SELECT retrieved_at FROM market_observations').retrieved_at, '2026-09-26T12:00:02.000Z');
  assert.equal(f.one('SELECT state FROM market_collection_jobs').state, 'done');
  await assert.rejects(collectPublish(f.env, a.jobId, new Date(f.now.getTime() + 2000), f.deps), /実行済み/);
  assert.equal(f.one('SELECT count(*) AS n FROM runs').n, 1);
});

test('concurrent continue requests claim once and do not fail the winning job', async t => {
  const f = fixture(); t.after(() => f.db.close());
  const a = await collectStart(f.env, f.now, f.deps);
  const results = await Promise.allSettled([collectContinue(f.env, a.jobId, f.now, f.deps), collectContinue(f.env, a.jobId, f.now, f.deps)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(f.requests.length, 2);
  assert.equal(f.one('SELECT state FROM market_collection_jobs').state, 'ready');
  assert.equal(f.one('SELECT count(*) AS n FROM runs').n, 0);
});

test('TTL boundary and changed NY date reject before fetching', async t => {
  for (const start of [new Date('2026-09-26T12:00:00Z'), new Date('2026-09-27T03:59:00Z')]) {
    const f = fixture(); t.after(() => f.db.close()); f.time(start);
    const a = await collectStart(f.env, start, f.deps);
    const expired = new Date(start.getTime() + (start.getUTCHours() === 3 ? 60_000 : 30 * 60_000));
    f.time(expired);
    await assert.rejects(collectContinue(f.env, a.jobId, expired, f.deps), /有効期限/);
    assert.equal(f.requests.length, 1);
    assert.equal(f.one('SELECT state FROM market_collection_jobs').state, 'failed');
    assert.equal(f.one('SELECT status FROM runs').status, 'failed');
  }
});

test('older-start job cannot replace newer history; first published observation stays immutable', async t => {
  const f = fixture(); t.after(() => f.db.close());
  const older = await collectStart(f.env, f.now, f.deps);
  await collectContinue(f.env, older.jobId, f.now, f.deps);
  const later = new Date(f.now.getTime() + 1000); f.time(later); f.price(200);
  const newer = await collectStart(f.env, later, f.deps);
  await collectContinue(f.env, newer.jobId, later, f.deps);
  await collectPublish(f.env, newer.jobId, later, f.deps);
  const original = f.one('SELECT payload FROM market_history').payload;
  await collectPublish(f.env, older.jobId, later, f.deps);
  assert.equal(f.one('SELECT payload FROM market_history').payload, original);
  assert.equal(f.one('SELECT payload FROM market_observations').payload, original);
  assert.equal(f.one('SELECT close FROM bars WHERE symbol=\'SOXL\'').close, 202);
});

test('expired publish fails the claimed publishing state; missing job is harmless 409', async t => {
  const f = fixture(); t.after(() => f.db.close());
  await assert.rejects(collectContinue(f.env, 'missing', f.now, f.deps),
    error => error instanceof Error && 'status' in error && error.status === 409);
  assert.equal(f.one('SELECT count(*) AS n FROM runs').n, 0);
  const a = await collectStart(f.env, f.now, f.deps);
  await collectContinue(f.env, a.jobId, f.now, f.deps);
  const expired = new Date(f.now.getTime() + 30 * 60_000); f.time(expired);
  await assert.rejects(collectPublish(f.env, a.jobId, expired, f.deps), /有効期限/);
  assert.equal(f.one('SELECT state FROM market_collection_jobs').state, 'failed');
  assert.equal(f.one('SELECT status FROM runs').status, 'failed');
  assert.equal(f.one('SELECT count(*) AS n FROM market_history').n, 0);
});

test('publish batch failure rolls back all history writes and records a safe failure', async t => {
  const f = fixture(); t.after(() => f.db.close());
  const seed = await collectStart(f.env, f.now, f.deps);
  await collectContinue(f.env, seed.jobId, f.now, f.deps);
  await collectPublish(f.env, seed.jobId, f.now, f.deps);
  const previous = f.one('SELECT payload FROM market_history').payload;
  const later = new Date(f.now.getTime() + 1000); f.time(later); f.price(200);
  const next = await collectStart(f.env, later, f.deps);
  await collectContinue(f.env, next.jobId, later, f.deps);
  f.db.exec(`CREATE TRIGGER fail_success BEFORE INSERT ON runs WHEN NEW.status='success'
    BEGIN SELECT RAISE(ABORT,'private-database-detail'); END;`);
  await assert.rejects(collectPublish(f.env, next.jobId, later, f.deps), error => error instanceof Error && !error.message.includes('private'));
  assert.equal(f.one('SELECT payload FROM market_history').payload, previous);
  assert.equal(f.one('SELECT close FROM bars WHERE symbol=\'SOXL\'').close, 102);
  assert.equal(f.one('SELECT count(*) AS n FROM market_observations').n, 1);
  assert.equal(f.one('SELECT count(*) AS n FROM runs WHERE status=\'failed\'').n, 1);
});

test('second-symbol upstream failure cannot publish partial data or expose upstream body', async t => {
  const f = fixture(); t.after(() => f.db.close());
  const a = await collectStart(f.env, f.now, f.deps); f.broken();
  await assert.rejects(collectContinue(f.env, a.jobId, f.now, f.deps), error => error instanceof Error && !error.message.includes('upstream-private'));
  assert.equal(f.one('SELECT count(*) AS n FROM market_history').n, 0);
  assert.equal(f.one('SELECT state FROM market_collection_jobs').state, 'failed');
  await assert.rejects(collectPublish(f.env, a.jobId, f.now, f.deps));
});
