import test from 'node:test';
import assert from 'node:assert/strict';
import {applyPortfolioChange as change, portfolioView as view, PortfolioError} from '../src/domain/portfolio.ts';
import type {Ledger, Opening, EntryInput, PortfolioChange} from '../src/domain/portfolio.ts';

const today = '2026-09-26';
const opening: Opening = {date: '2026-01-01', cashJpy: '100000', cashUsd: '1000', holdings: []};
const init = (o: Opening = opening) => change(null, {type: 'initialize', opening: o, monthlyPlanJpy: '10000'}, '', today);
const apply = (l: Ledger | null, c: unknown, id = 'new') => change(l, c, id, today);
const add = (l: Ledger, entry: EntryInput, id = 'new') => apply(l, {type: 'add', entry}, id);
const deposit = (amount = '10', date = '2026-01-02'): EntryInput => ({kind: 'deposit', date, currency: 'USD', amount});
const buy = (quantity = '3', grossUsd = '100', feeUsd = '1', date = '2026-01-03'): EntryInput => ({kind: 'buy', date, symbol: 'SOXL', quantity, grossUsd, feeUsd});
const sell = (quantity = '1', grossUsd = '40', feeUsd = '1', date = '2026-01-04'): EntryInput => ({kind: 'sell', date, symbol: 'SOXL', quantity, grossUsd, feeUsd});
const position = (l: Ledger) => view(l).positions[0];
function rejects(fn: () => unknown) {
  assert.throws(fn, (e: unknown) => e instanceof PortfolioError && /[ぁ-んァ-ン一-龯]/.test(e.message));
}
function freeze<T>(v: T): T {
  if (v && typeof v === 'object') { for (const child of Object.values(v)) freeze(child); Object.freeze(v); }
  return v;
}

test('empty view, initialization and canonical decimal strings; opening holdings are separate from cash', () => {
  assert.deepEqual(view(null), {initialized: false, opening: null, monthlyPlanJpy: '0', cash: {JPY: '0', USD: '0.00'}, entries: [], positions: ['SOXL', 'TQQQ'].map(symbol => ({symbol, quantity: '0.000000', costUsd: '0.00', averageCostUsd: null, realizedPnlUsd: '0.00'}))});
  const l = init({...opening, cashUsd: '0001.2', holdings: [{symbol: 'SOXL', quantity: '02.5', costUsd: '10'}]});
  assert.equal(l.opening.cashUsd, '1.20');
  assert.deepEqual(view(l).cash, {JPY: '100000', USD: '1.20'});
  assert.deepEqual(position(l), {symbol: 'SOXL', quantity: '2.500000', costUsd: '10.00', averageCostUsd: '4.0000', realizedPnlUsd: '0.00'});
  assert.equal(view(apply(l, {type: 'plan', monthlyPlanJpy: '000'})).monthlyPlanJpy, '0');
  assert.deepEqual(view(apply(l, {type: 'plan', monthlyPlanJpy: '99999'})).cash, view(l).cash);
});

test('deposits, withdrawals and both FX directions use independent currency balances', () => {
  let l = init();
  const events: EntryInput[] = [deposit('0.10'), deposit('0.20'),
    {kind: 'deposit', date: '2026-01-02', currency: 'JPY', amount: '50'},
    {kind: 'withdraw', date: '2026-01-02', currency: 'JPY', amount: '100'},
    {kind: 'withdraw', date: '2026-01-02', currency: 'USD', amount: '0.30'},
    {kind: 'fx', date: '2026-01-02', from: 'JPY', to: 'USD', paid: '15000', received: '100.01'},
    {kind: 'fx', date: '2026-01-02', from: 'USD', to: 'JPY', paid: '10.01', received: '1400'}];
  for (const [i, e] of events.entries()) l = add(l, e, String(i));
  assert.deepEqual(view(l).cash, {JPY: '86350', USD: '1090.00'});
});

test('buy fees enter weighted basis; partial sell rounds cents and final sale consumes residual', () => {
  let l = add(init(), buy(), 'buy');
  assert.equal(view(l).cash.USD, '899.00');
  assert.equal(position(l).averageCostUsd, '33.6667');
  l = add(l, sell(), 'sell-1');
  assert.deepEqual(position(l), {symbol: 'SOXL', quantity: '2.000000', costUsd: '67.33', averageCostUsd: '33.6650', realizedPnlUsd: '5.33'});
  l = add(l, sell(), 'sell-2');
  assert.equal(position(l).costUsd, '33.66'); // 67.33 / 2 rounds half up to 33.67.
  l = add(l, sell(), 'sell-3');
  assert.deepEqual(position(l), {symbol: 'SOXL', quantity: '0.000000', costUsd: '0.00', averageCostUsd: null, realizedPnlUsd: '16.00'});
  assert.equal(view(l).cash.USD, '1016.00');
});

test('multiple lots use weighted average, losses stay signed, and zero-cost holdings are supported', () => {
  let l = init({...opening, holdings: [{symbol: 'SOXL', quantity: '2', costUsd: '10'}]});
  l = add(l, buy('1', '19', '1'), 'b');
  assert.equal(position(l).averageCostUsd, '10.0000');
  l = add(l, sell('1', '5', '1'), 's');
  assert.equal(position(l).costUsd, '20.00');
  assert.equal(position(l).realizedPnlUsd, '-6.00');
  const free = init({...opening, holdings: [{symbol: 'SOXL', quantity: '1', costUsd: '0'}]});
  assert.equal(position(add(free, sell())).realizedPnlUsd, '39.00');
  const tiny = init({...opening, holdings: [{symbol: 'SOXL', quantity: '200', costUsd: '0.01'}]});
  assert.equal(position(tiny).averageCostUsd, '0.0001');
});

test('independent integer oracle verifies repeated cent allocations and cash conservation', () => {
  // Oracle works in whole shares/cents, using quotient/remainder instead of production rounding.
  let l = init({...opening, cashUsd: '0', holdings: [{symbol: 'SOXL', quantity: '97', costUsd: '13.01'}]});
  let shares = 97n, basis = 1301n, pnl = 0n, cash = 0n;
  const cents = (n: bigint) => `${n < 0n ? '-' : ''}${(n < 0n ? -n : n) / 100n}.${((n < 0n ? -n : n) % 100n).toString().padStart(2, '0')}`;
  for (let i = 0; i < 97; i++) {
    let allocated = basis / shares;
    if ((basis % shares) * 2n >= shares) allocated++;
    basis -= allocated; shares--; pnl += 19n - allocated; cash += 19n;
    l = add(l, sell('1', '0.20', '0.01'), `sale-${i}`);
    assert.equal(position(l).costUsd, cents(basis));
    assert.equal(position(l).realizedPnlUsd, cents(pnl));
    assert.equal(view(l).cash.USD, cents(cash));
  }
  assert.equal(position(l).costUsd, '0.00');
  assert.equal(position(l).realizedPnlUsd, '5.42');
});

test('exact arithmetic remains correct above Number safe integer minor units', () => {
  const l = add(init({...opening, cashUsd: '90071992547409.91'}), deposit('0.02'));
  assert.equal(view(l).cash.USD, '90071992547409.93');
});

test('chronology sorts dates but keeps array order on the same day', () => {
  let l = init({...opening, cashUsd: '0'});
  l = add(l, deposit('10', '2026-01-03'), 'late');
  l = add(l, deposit('5', '2026-01-02'), 'early');
  l = add(l, {kind: 'withdraw', date: '2026-01-03', currency: 'USD', amount: '15'}, 'out');
  assert.deepEqual(l.entries.map(e => e.id), ['late', 'early', 'out']);
  assert.deepEqual(view(l).entries.map(e => e.id), ['early', 'late', 'out']);
  assert.equal(view(l).cash.USD, '0.00');
  rejects(() => apply(l, {type: 'edit', id: 'late', entry: deposit('10', '2026-01-04')}));
  const holding = add(add(init(), buy('1'), 'b'), sell('1', '150', '0', '2026-01-03'), 's');
  rejects(() => view({...holding, entries: [...holding.entries].reverse()}));
});

test('historical edits/opening/void reject deficits despite positive final balances and are pure', () => {
  let l = add(init({...opening, cashUsd: '0'}), deposit('100'), 'fund');
  l = add(l, buy('1', '100', '0'), 'b');
  l = add(l, deposit('100', '2026-01-05'), 'later');
  freeze(l); const before = JSON.stringify(l);
  rejects(() => apply(l, {type: 'edit', id: 'fund', entry: deposit('99')}));
  rejects(() => apply(l, {type: 'void', id: 'fund'}));
  rejects(() => apply(l, {type: 'opening', opening: {...opening, date: '2026-01-03'}}));
  assert.equal(JSON.stringify(l), before);
  let funded = add(init({...opening, cashUsd: '100'}), buy('1', '100', '0'));
  funded = add(funded, deposit('100', '2026-01-05'), 'later');
  rejects(() => apply(funded, {type: 'opening', opening: {...opening, cashUsd: '99'}}));
});

test('void and restore replay dependencies; edit preserves ID, void flag and tie order', () => {
  let l = add(add(init(), buy('1'), 'b'), sell(), 's');
  rejects(() => apply(l, {type: 'void', id: 'b'}));
  l = apply(l, {type: 'void', id: 's'});
  l = apply(l, {type: 'void', id: 'b'});
  rejects(() => apply(l, {type: 'restore', id: 's'}));
  l = apply(l, {type: 'edit', id: 'b', entry: buy('2')}, 'must-not-replace-id');
  assert.equal(l.entries[0].id, 'b'); assert.equal(l.entries[0].voided, true);
  l = apply(l, {type: 'restore', id: 'b'});
  l = apply(l, {type: 'restore', id: 's'});
  assert.equal(position(l).quantity, '1.000000');
  assert.deepEqual(l.entries.map(e => e.id), ['b', 's']);
  assert.deepEqual(apply(l, {type: 'restore', id: 's'}), l);
});

test('successful changes and views never alias input objects', () => {
  const raw = {...opening, holdings: [{symbol: 'SOXL' as const, quantity: '1', costUsd: '10'}]};
  const l = freeze(init(raw));
  raw.holdings[0].costUsd = '99';
  const result = apply(l, {type: 'plan', monthlyPlanJpy: '123'});
  result.opening.holdings[0].costUsd = '88.00';
  const v = view(l); v.opening!.holdings[0].costUsd = '77.00';
  assert.equal(l.opening.holdings[0].costUsd, '10.00');
});

test('splits preserve cost and realized results; reverse/fractional splits require exact microshares', () => {
  const split = (numerator: string, denominator: string): EntryInput => ({kind: 'split', symbol: 'SOXL', date: '2026-01-04', numerator, denominator});
  let l = add(init(), buy('3'), 'b');
  l = add(l, split('2', '1'), 'split');
  assert.equal(position(l).quantity, '6.000000'); assert.equal(position(l).costUsd, '101.00');
  assert.equal(position(l).averageCostUsd, '16.8333');
  l = add(l, split('1', '4'), 'reverse');
  assert.equal(position(l).quantity, '1.500000'); assert.equal(position(l).costUsd, '101.00');
  l = add(l, sell('1.5', '110', '1'), 's');
  assert.equal(position(l).realizedPnlUsd, '8.00');
  const micro = init({...opening, holdings: [{symbol: 'SOXL', quantity: '0.000001', costUsd: '1'}]});
  rejects(() => add(micro, split('1', '2')));
  rejects(() => add(init(), split('0', '1')));
  rejects(() => add(init(), split('1', '1.0')));
  rejects(() => add(init(), split('1000000001', '1')));
  assert.equal(position(add(init(), split('2', '1'))).quantity, '0.000000');
});

test('historical split changes can invalidate a later sale', () => {
  let l = add(init(), buy('1'), 'b');
  l = add(l, {kind: 'split', date: '2026-01-03', symbol: 'SOXL', numerator: '2', denominator: '1'}, 'sp');
  l = add(l, sell('2'), 's');
  rejects(() => apply(l, {type: 'void', id: 'sp'}));
  rejects(() => apply(l, {type: 'edit', id: 'sp', entry: {kind: 'split', date: '2026-01-03', symbol: 'SOXL', numerator: '1', denominator: '1'}}));
});

test('cash overdrafts, fees and overselling are checked for every currency and symbol', () => {
  for (const e of [buy('1', '1000', '0.01'), sell(),
    {kind: 'withdraw', date: today, currency: 'JPY', amount: '100001'},
    {kind: 'withdraw', date: today, currency: 'USD', amount: '1000.01'},
    {kind: 'fx', date: today, from: 'JPY', to: 'USD', paid: '100001', received: '1'},
    {kind: 'fx', date: today, from: 'USD', to: 'JPY', paid: '1001', received: '1'}]) rejects(() => apply(init(), {type: 'add', entry: e}));
  let l = add(init(), buy('1'), 'b');
  rejects(() => add(l, sell('1.000001')));
  rejects(() => apply(l, {type: 'add', entry: {...sell(), symbol: 'TQQQ'}}));
  l = add(l, sell('1', '1', '2'), 's'); // Fee may exceed proceeds if available cash covers it.
  assert.equal(view(l).cash.USD, '898.00');
});

test('dates are real calendar days, not permissively parsed timestamps', () => {
  for (const d of ['2026-02-29', '1900-02-29', '2026-04-31', '2026-00-01', '2026-13-01', '2026-01-00', '0000-01-01', '2026-1-01', '2026-01-01T00:00:00Z', '2026-09-27', '2025-12-31', '', '2026-01-01\n']) rejects(() => add(init(), deposit('1', d)));
  for (const d of ['2000-02-29', '2024-02-29', today]) assert.equal(init({...opening, date: d}).opening.date, d);
  rejects(() => change(null, {type: 'initialize', opening, monthlyPlanJpy: '0'}, '', '2026-02-30'));
  rejects(() => init({...opening, date: '2026-09-27'}));
});

test('strict decimal grammar, precision, positivity and bounded inputs', () => {
  for (const amount of ['-1', '+1', '1e2', '.1', '1.', ' 1', '1 ', 'NaN', 'Infinity', '0', '0.00', '0.001', '1.000', '1\n', '9'.repeat(10000), 1, null]) rejects(() => apply(init(), {type: 'add', entry: {...deposit(), amount}}));
  rejects(() => apply(init(), {type: 'add', entry: {kind: 'deposit', date: today, currency: 'JPY', amount: '1.0'}}));
  for (const entry of [{...buy(), quantity: '0.0000001'}, {...buy(), quantity: '0'}, {...buy(), grossUsd: '0'}, {...buy(), feeUsd: '-1'}, {...buy(), feeUsd: '0.001'}]) rejects(() => apply(init(), {type: 'add', entry}));
  rejects(() => apply(init(), {type: 'plan', monthlyPlanJpy: '-1'}));
  rejects(() => init({...opening, cashUsd: '-1'}));
  rejects(() => init({...opening, cashUsd: '10000000000000000'}));
});

test('aggregate cash, shares, basis and realized pnl are bounded', () => {
  rejects(() => add(init({...opening, cashUsd: '9999999999999999.99'}), deposit('0.01')));
  const hugeShares = init({...opening, holdings: [{symbol: 'SOXL', quantity: '999999999999.999999', costUsd: '0'}]});
  rejects(() => add(hugeShares, buy('0.000001', '0.01', '0')));
  rejects(() => add(hugeShares, {kind: 'split', date: today, symbol: 'SOXL', numerator: '2', denominator: '1'}));
  const hugeCost = init({...opening, holdings: [{symbol: 'SOXL', quantity: '1', costUsd: '9999999999999999.99'}]});
  rejects(() => add(hugeCost, buy('1', '0.01', '0')));
  let l = init({...opening, cashUsd: '0', holdings: [{symbol: 'SOXL', quantity: '2', costUsd: '0'}]});
  l = add(l, sell('1', '9999999999999999.99', '0'), 's1');
  l = add(l, {kind: 'withdraw', date: '2026-01-04', currency: 'USD', amount: '9999999999999999.99'}, 'w');
  rejects(() => add(l, sell('1', '0.01', '0'), 's2'));
});

test('opening holdings reject duplicates, unsupported symbols and orphan cost', () => {
  const h = {symbol: 'SOXL' as const, quantity: '1', costUsd: '1'};
  rejects(() => init({...opening, holdings: [h, h]}));
  rejects(() => apply(null, {type: 'initialize', opening: {...opening, holdings: [{...h, symbol: 'SPY'}]}, monthlyPlanJpy: '0'}));
  rejects(() => init({...opening, holdings: [{...h, quantity: '0'}]}));
  assert.equal(position(init({...opening, holdings: [{...h, quantity: '0', costUsd: '0'}]})).averageCostUsd, null);
});

test('unknown shapes, extra fields, client ids/flags and malformed discriminants are rejected', () => {
  for (const c of [null, [], 'initialize', {}, {kind: 'plan', monthlyPlanJpy: '1'}, {type: 'plan', monthlyPlanJpy: '1', extra: true}, {type: 'plan'}, {type: 'unknown'}, {type: 'add', entry: {...deposit(), id: 'override'}}, {type: 'add', entry: {...deposit(), voided: true}}, {type: 'add', entry: {...deposit(), note: 3}}, {type: 'add', entry: {...deposit(), note: 'x'.repeat(1001)}}, {type: 'add', entry: {...deposit(), currency: 'EUR'}}, {type: 'add', entry: {...deposit(), kind: 'unknown'}}, {type: 'add', entry: {kind: 'fx', date: today, from: 'USD', to: 'USD', paid: '1', received: '1'}}]) rejects(() => apply(init(), c));
  rejects(() => apply(init(), {type: 'opening', opening: {...opening, extra: true}}));
  rejects(() => apply(init(), {type: 'edit', id: 'missing', entry: deposit()}));
  rejects(() => apply(init(), {type: 'void', id: 'missing'}));
  rejects(() => apply(init(), {type: 'restore', id: 'missing'}));
  const noted = add(init(), {...deposit(), note: '個人メモ'});
  assert.equal(noted.entries[0].note, '個人メモ');
});

test('persisted schema, flags, ids and nested shapes are strictly validated by both public functions', () => {
  const l = add(init(), deposit());
  for (const invalid of [{...l, schemaVersion: '1'}, {...l, schemaVersion: 2}, {...l, extra: true}, {...l, entries: [{...l.entries[0], voided: 'false'}]}, {...l, entries: [{...deposit(), id: 'x'}]}, {...l, entries: [{...l.entries[0], extra: true}]}, {...l, entries: [l.entries[0], l.entries[0]]}, {...l, entries: [{...l.entries[0], id: ''}]}, {...l, entries: [{...l.entries[0], date: '2025-12-31', voided: true}]}, {...l, entries: new Array(1)}]) {
    rejects(() => view(invalid as Ledger));
    rejects(() => apply(invalid as Ledger, {type: 'plan', monthlyPlanJpy: '0'}));
  }
});

test('initialization state, ID ownership and maximum journal size including voided records', () => {
  rejects(() => apply(init(), {type: 'initialize', opening, monthlyPlanJpy: '0'}));
  const changes: PortfolioChange[] = [{type: 'opening', opening}, {type: 'plan', monthlyPlanJpy: '0'}, {type: 'add', entry: deposit()}, {type: 'edit', id: 'x', entry: deposit()}, {type: 'void', id: 'x'}, {type: 'restore', id: 'x'}];
  for (const c of changes) rejects(() => apply(null, c));
  for (const key of ['', ' ', 'x'.repeat(129), 'bad\n']) rejects(() => add(init(), deposit(), key));
  const l = add(init(), deposit(), 'unique');
  rejects(() => add(l, deposit(), 'unique'));
  const full: Ledger = {...init(), entries: Array.from({length: 500}, (_, i) => ({...deposit(), id: `id-${i}`, voided: true}))};
  assert.equal(view(full).entries.length, 500);
  rejects(() => add(full, deposit()));
  assert.equal(apply(full, {type: 'plan', monthlyPlanJpy: '1'}).entries.length, 500);
  rejects(() => view({...full, entries: [...full.entries, {...deposit(), id: '501', voided: true}]}));
});
