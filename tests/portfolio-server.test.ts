import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { readPortfolio, writePortfolio } from '../src/server/portfolio.ts';
import { AppError, type Env } from '../src/server/types.ts';
import type { PortfolioChange } from '../src/domain/portfolio.ts';

const now = new Date('2026-09-26T12:00:00Z');
const envelope = (revision: number, change: PortfolioChange, requestId = crypto.randomUUID()) => ({ requestId, revision, change });
const deposit = (amount: string): PortfolioChange => ({ type: 'add', entry: { kind: 'deposit', currency: 'USD', amount, date: '2026-09-26' } });
const hasStatus = (status: number) => (error: unknown) => error instanceof AppError && error.status === status;

function fixture() {
  const db = new DatabaseSync(':memory:');
  for (const name of ['0001_validation.sql', '0007_portfolio.sql']) {
    db.exec(readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  }
  let gate: { remaining: number; wait: Promise<void>; release: () => void } | undefined;
  function prepare(sql: string) {
    let args: (string | number | null)[] = [];
    const statement = {
      bind(...values: (string | number | null)[]) { args = values; return statement; },
      async first() {
        const row = db.prepare(sql).get(...args) ?? null;
        // Force both handlers to compute from the same revision before either CAS.
        if (gate && sql === 'SELECT revision,payload FROM portfolio_state WHERE id=1') {
          const current = gate;
          if (--current.remaining === 0) { gate = undefined; current.release(); }
          await current.wait;
        }
        return row;
      },
      execute() {
        const r = db.prepare(sql).run(...args);
        return { success: true, meta: { changes: Number(r.changes) } };
      },
      async run() { return statement.execute(); },
    };
    return statement;
  }
  const env = { DB: {
    prepare,
    async batch(statements: ReturnType<typeof prepare>[]) {
      db.exec('BEGIN');
      try { const result = statements.map(s => s.execute()); db.exec('COMMIT'); return result; }
      catch (error) { db.exec('ROLLBACK'); throw error; }
    },
  } } as unknown as Env;
  const financialState = () => ({
    state: db.prepare('SELECT * FROM portfolio_state').all(),
    receipts: db.prepare('SELECT * FROM portfolio_requests ORDER BY applied_revision').all(),
  });
  const initialize = () => writePortfolio(env, envelope(0, { type: 'initialize',
    opening: { date: '2026-09-25', cashJpy: '10000', cashUsd: '100', holdings: [] }, monthlyPlanJpy: '0' }), now);
  return { db, env, financialState, initialize,
    raceStateReads() {
      let release!: () => void;
      const wait = new Promise<void>(resolve => { release = resolve; });
      gate = { remaining: 2, wait, release };
    },
  };
}

test('concurrent identical envelopes apply a deposit once and return one replay', { timeout: 3000 }, async t => {
  const f = fixture(); t.after(() => f.db.close()); await f.initialize();
  const body = envelope(1, deposit('25'));
  f.raceStateReads();
  const results = await Promise.all([writePortfolio(f.env, body, now), writePortfolio(f.env, structuredClone(body), now)]);
  assert.deepEqual(results.map(r => r.replayed).sort(), [false, true]);
  assert.ok(results.every(r => r.ok && r.revision === 2));
  const view = await readPortfolio(f.env);
  assert.equal(view.revision, 2); assert.equal(view.cash.USD, '125.00');
  assert.equal(view.entries.length, 1); assert.equal(view.entries[0].id, body.requestId);
  assert.equal(f.financialState().receipts.length, 2);
});

test('same request ID with different payload returns 409 without changing financial state', async t => {
  const f = fixture(); t.after(() => f.db.close()); await f.initialize();
  const body = envelope(1, deposit('25')); await writePortfolio(f.env, body, now);
  const before = f.financialState();
  await assert.rejects(writePortfolio(f.env, { ...body, change: deposit('30') }, now), hasStatus(409));
  assert.deepEqual(f.financialState(), before);
});

test('concurrent different IDs at the same revision produce one commit and one 409', { timeout: 3000 }, async t => {
  const f = fixture(); t.after(() => f.db.close()); await f.initialize();
  const bodies = [envelope(1, deposit('25')), envelope(1, deposit('40'))];
  f.raceStateReads();
  const outcomes = await Promise.allSettled(bodies.map(body => writePortfolio(f.env, body, now)));
  assert.equal(outcomes.filter(r => r.status === 'fulfilled').length, 1);
  const loser = outcomes.find(r => r.status === 'rejected');
  assert.ok(loser && loser.status === 'rejected' && hasStatus(409)(loser.reason));
  const winner = outcomes.findIndex(r => r.status === 'fulfilled');
  const view = await readPortfolio(f.env);
  assert.equal(view.revision, 2); assert.equal(view.entries.length, 1);
  assert.equal(view.entries[0].id, bodies[winner].requestId);
  assert.equal(view.cash.USD, winner === 0 ? '125.00' : '140.00');
  assert.equal(f.financialState().receipts.length, 2);
  assert.equal(f.db.prepare('SELECT count(*) AS n FROM portfolio_requests WHERE request_id=?').get(bodies[1 - winner].requestId)!.n, 0);
});

test('stale revision returns 409 and preserves the full financial state', async t => {
  const f = fixture(); t.after(() => f.db.close()); await f.initialize();
  await writePortfolio(f.env, envelope(1, deposit('25')), now);
  const before = f.financialState();
  await assert.rejects(writePortfolio(f.env, envelope(1, deposit('40')), now), hasStatus(409));
  assert.deepEqual(f.financialState(), before);
});

test('invalid entries return 400 atomically without a receipt or state change', async t => {
  const f = fixture(); t.after(() => f.db.close()); await f.initialize();
  const before = f.financialState();
  const invalid: PortfolioChange[] = [
    deposit('0.001'),
    { type: 'add', entry: { kind: 'withdraw', currency: 'USD', amount: '101', date: '2026-09-26' } },
  ];
  for (const change of invalid) {
    await assert.rejects(writePortfolio(f.env, envelope(1, change), now), hasStatus(400));
    assert.deepEqual(f.financialState(), before);
  }
  assert.equal((await readPortfolio(f.env)).cash.USD, '100.00');
});

test('receipt insertion failure rolls back the preceding state update and permits retry', async t => {
  const f = fixture(); t.after(() => f.db.close()); await f.initialize();
  const body = envelope(1, deposit('25'));
  const before = f.financialState();
  f.db.exec(`CREATE TRIGGER reject_receipt BEFORE INSERT ON portfolio_requests
    BEGIN SELECT RAISE(ABORT,'fixture-receipt-failure'); END;`);
  await assert.rejects(writePortfolio(f.env, body, now), /fixture-receipt-failure/);
  assert.deepEqual(f.financialState(), before);
  f.db.exec('DROP TRIGGER reject_receipt');
  assert.deepEqual(await writePortfolio(f.env, body, now), { ok: true, revision: 2, replayed: false });
  assert.equal((await readPortfolio(f.env)).cash.USD, '125.00');
});

test('original receipt replays its applied revision after subsequent changes without undoing them', async t => {
  const f = fixture(); t.after(() => f.db.close()); await f.initialize();
  const original = envelope(1, deposit('25'));
  await writePortfolio(f.env, original, now);
  await writePortfolio(f.env, envelope(2, deposit('40')), new Date(now.getTime() + 1000));
  const before = f.financialState();
  assert.deepEqual(await writePortfolio(f.env, original, new Date(now.getTime() + 2000)),
    { ok: true, revision: 2, replayed: true });
  assert.deepEqual(f.financialState(), before);
  const view = await readPortfolio(f.env);
  assert.equal(view.revision, 3); assert.equal(view.cash.USD, '165.00'); assert.equal(view.entries.length, 2);
});

test('revision cap rejects new changes with 409 but still replays an existing receipt', async t => {
  const f = fixture(); t.after(() => f.db.close()); await f.initialize();
  const original = envelope(1, deposit('25'));
  await writePortfolio(f.env, original, now);
  f.db.prepare('UPDATE portfolio_state SET revision=10000 WHERE id=1').run();
  const before = f.financialState();
  await assert.rejects(writePortfolio(f.env, envelope(10000, deposit('40')), now), hasStatus(409));
  assert.deepEqual(f.financialState(), before);
  assert.deepEqual(await writePortfolio(f.env, original, now), { ok: true, revision: 2, replayed: true });
  assert.deepEqual(f.financialState(), before);
  const view = await readPortfolio(f.env);
  assert.equal(view.revision, 10000); assert.equal(view.cash.USD, '125.00'); assert.equal(view.entries.length, 1);
});
