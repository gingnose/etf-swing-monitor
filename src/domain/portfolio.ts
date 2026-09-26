/** Private bookkeeping only. Decimal strings are canonical fixed-scale values. */
export type Currency = 'JPY' | 'USD';
type Symbol = 'SOXL' | 'TQQQ';
export type PortfolioOpening = {
  date: string; cashJpy: string; cashUsd: string;
  holdings: Array<{symbol: Symbol; quantity: string; costUsd: string}>;
};
export type Opening = PortfolioOpening;
export type PortfolioEntryInput = {date: string; note?: string} & (
  | {kind: 'deposit' | 'withdraw'; currency: Currency; amount: string}
  | {kind: 'fx'; from: Currency; to: Currency; paid: string; received: string}
  | {kind: 'buy' | 'sell'; symbol: Symbol; quantity: string; grossUsd: string; feeUsd: string}
  | {kind: 'split'; symbol: Symbol; numerator: string; denominator: string}
);
export type EntryInput = PortfolioEntryInput;
export type Entry = PortfolioEntryInput & {id: string; voided: boolean};
export type PortfolioLedger = {schemaVersion: 1; opening: Opening; monthlyPlanJpy: string; entries: Entry[]};
export type Ledger = PortfolioLedger;
export type PortfolioChange =
  | {type: 'initialize'; opening: Opening; monthlyPlanJpy: string}
  | {type: 'opening'; opening: Opening}
  | {type: 'plan'; monthlyPlanJpy: string}
  | {type: 'add'; entry: EntryInput}
  | {type: 'edit'; id: string; entry: EntryInput}
  | {type: 'void' | 'restore'; id: string};
export type PortfolioView = {
  initialized: boolean; opening: Opening | null; monthlyPlanJpy: string;
  cash: {JPY: string; USD: string};
  positions: Array<{symbol: Symbol; quantity: string; costUsd: string; averageCostUsd: string | null; realizedPnlUsd: string}>;
  entries: Entry[];
};
export class PortfolioError extends Error {
  constructor(message = '入力内容を確認してください。') { super(message); this.name = 'PortfolioError'; }
}

// Bounds apply to every input and every historical balance (in minor units).
const LIMIT = 999_999_999_999_999_999n;
const symbols: Symbol[] = ['SOXL', 'TQQQ'];
const fail = (message?: string): never => { throw new PortfolioError(message); };
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return fail();
  return value as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  if (Reflect.ownKeys(value).some(k => typeof k !== 'string' || ![...required, ...optional].includes(k)) ||
      required.some(k => !Object.hasOwn(value, k))) fail();
}
function bounded(value: bigint, signed = false): bigint {
  if (value > LIMIT || value < (signed ? -LIMIT : 0n)) fail('残高または数量が許容範囲を超えています。');
  return value;
}
function decimal(value: unknown, scale: number, positive = false): bigint {
  if (typeof value !== 'string' || value.length > 32 || !/^\d+(?:\.\d+)?$/.test(value)) return fail('金額または数量の形式が正しくありません。');
  const [whole, fraction = ''] = value.split('.');
  if (fraction.length > scale) fail('金額または数量の小数桁数が多すぎます。');
  const result = bounded(BigInt(whole) * 10n ** BigInt(scale) + BigInt(fraction.padEnd(scale, '0') || '0'));
  if (positive && result === 0n) fail('金額または数量は正の値を指定してください。');
  return result;
}
function format(value: bigint, scale: number): string {
  const sign = value < 0n ? '-' : '';
  const digits = (value < 0n ? -value : value).toString().padStart(scale + 1, '0');
  return sign + (scale ? digits.slice(0, -scale) + '.' + digits.slice(-scale) : digits);
}
const normalized = (v: unknown, scale: number, positive = false) => format(decimal(v, scale, positive), scale);
function currency(v: unknown): Currency { if (v !== 'JPY' && v !== 'USD') return fail(); return v; }
function symbol(v: unknown): Symbol { if (v !== 'SOXL' && v !== 'TQQQ') return fail(); return v; }
function date(v: unknown, today: string): string {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return fail('日付が正しくありません。');
  const [year, month, day] = v.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > days[month - 1] || v > today) return fail('日付が正しくありません。');
  return v;
}
function id(v: unknown): string {
  if (typeof v !== 'string' || !v.trim() || v.length > 128 || /[\u0000-\u001f\u007f]/.test(v)) return fail('記録の識別子が正しくありません。');
  return v;
}
function opening(value: unknown, today: string): Opening {
  const v = object(value); fields(v, ['date', 'cashJpy', 'cashUsd', 'holdings']);
  if (!Array.isArray(v.holdings) || v.holdings.length > 2) return fail();
  const seen = new Set<Symbol>();
  const holdings = Array.from(v.holdings, raw => {
    const h = object(raw); fields(h, ['symbol', 'quantity', 'costUsd']);
    const s = symbol(h.symbol);
    if (seen.has(s)) fail('開始時点の銘柄が重複しています。');
    seen.add(s);
    const quantity = normalized(h.quantity, 6);
    const costUsd = normalized(h.costUsd, 2);
    if (quantity === '0.000000' && costUsd !== '0.00') fail('数量がゼロの取得原価はゼロにしてください。');
    return {symbol: s, quantity, costUsd};
  });
  return {date: date(v.date, today), cashJpy: normalized(v.cashJpy, 0), cashUsd: normalized(v.cashUsd, 2), holdings};
}
function input(value: unknown, today: string): EntryInput {
  const v = object(value);
  const common = ['kind', 'date'];
  const extra = v.kind === 'deposit' || v.kind === 'withdraw' ? ['currency', 'amount'] :
    v.kind === 'fx' ? ['from', 'to', 'paid', 'received'] :
    v.kind === 'buy' || v.kind === 'sell' ? ['symbol', 'quantity', 'grossUsd', 'feeUsd'] :
    v.kind === 'split' ? ['symbol', 'numerator', 'denominator'] : fail();
  fields(v, [...common, ...extra], ['note']);
  const base: {date: string; note?: string} = {date: date(v.date, today)};
  if (Object.hasOwn(v, 'note')) {
    if (typeof v.note !== 'string' || v.note.length > 1000) return fail('メモは1000文字以内で入力してください。');
    base.note = v.note;
  }
  if (v.kind === 'deposit' || v.kind === 'withdraw') {
    const c = currency(v.currency);
    return {...base, kind: v.kind, currency: c, amount: normalized(v.amount, c === 'JPY' ? 0 : 2, true)};
  }
  if (v.kind === 'fx') {
    const from = currency(v.from), to = currency(v.to);
    if (from === to) fail('両替には異なる通貨を指定してください。');
    return {...base, kind: 'fx', from, to, paid: normalized(v.paid, from === 'JPY' ? 0 : 2, true), received: normalized(v.received, to === 'JPY' ? 0 : 2, true)};
  }
  if (v.kind === 'buy' || v.kind === 'sell') return {...base, kind: v.kind, symbol: symbol(v.symbol), quantity: normalized(v.quantity, 6, true), grossUsd: normalized(v.grossUsd, 2, true), feeUsd: normalized(v.feeUsd, 2)};
  const numerator = normalized(v.numerator, 0, true), denominator = normalized(v.denominator, 0, true);
  if (BigInt(numerator) > 1_000_000_000n || BigInt(denominator) > 1_000_000_000n) fail('分割比率が許容範囲を超えています。');
  return {...base, kind: 'split', symbol: symbol(v.symbol), numerator, denominator};
}
function ledger(value: unknown, today: string): Ledger {
  const v = object(value); fields(v, ['schemaVersion', 'opening', 'monthlyPlanJpy', 'entries']);
  if (v.schemaVersion !== 1 || !Array.isArray(v.entries) || v.entries.length > 500) return fail('台帳の形式または記録件数が正しくありません。');
  const seen = new Set<string>();
  const entries = Array.from(v.entries, raw => {
    const e = object(raw);
    if (!Object.hasOwn(e, 'id') || !Object.hasOwn(e, 'voided') || typeof e.voided !== 'boolean') return fail();
    const key = id(e.id);
    if (seen.has(key)) fail('記録の識別子が重複しています。');
    seen.add(key);
    const {id: _id, voided: _voided, ...rest} = e;
    return {...input(rest, today), id: key, voided: e.voided};
  });
  const result: Ledger = {schemaVersion: 1, opening: opening(v.opening, today), monthlyPlanJpy: normalized(v.monthlyPlanJpy, 0), entries};
  if (entries.some(e => e.date < result.opening.date)) fail('記録の日付は開始日以降にしてください。');
  return result;
}
const halfUp = (numerator: bigint, denominator: bigint) => (numerator * 2n + denominator) / (denominator * 2n);
function replay(l: Ledger | null): PortfolioView {
  const cash = {JPY: l ? decimal(l.opening.cashJpy, 0) : 0n, USD: l ? decimal(l.opening.cashUsd, 2) : 0n};
  const positions = symbols.map(symbol => ({symbol, quantity: 0n, costUsd: 0n, realizedPnlUsd: 0n}));
  for (const h of l?.opening.holdings ?? []) Object.assign(positions.find(p => p.symbol === h.symbol)!, {quantity: decimal(h.quantity, 6), costUsd: decimal(h.costUsd, 2)});
  // Explicit index tie-break keeps same-day event ordering portable and deterministic.
  const entries = (l?.entries ?? []).map((e, i) => ({e, i})).sort((a, b) => a.e.date < b.e.date ? -1 : a.e.date > b.e.date ? 1 : a.i - b.i).map(x => x.e);
  for (const e of entries) {
    if (e.voided) continue;
    if (e.kind === 'deposit' || e.kind === 'withdraw') {
      cash[e.currency] += decimal(e.amount, e.currency === 'JPY' ? 0 : 2) * (e.kind === 'deposit' ? 1n : -1n);
    } else if (e.kind === 'fx') {
      cash[e.from] -= decimal(e.paid, e.from === 'JPY' ? 0 : 2);
      cash[e.to] += decimal(e.received, e.to === 'JPY' ? 0 : 2);
    } else if (e.kind === 'buy' || e.kind === 'sell' || e.kind === 'split') {
      const p = positions.find(p => p.symbol === e.symbol)!;
      if (e.kind === 'split') {
        const product = p.quantity * BigInt(e.numerator), denominator = BigInt(e.denominator);
        if (product % denominator !== 0n) fail('分割後の数量を小数点以下6桁で表せません。');
        p.quantity = bounded(product / denominator);
      } else {
        const quantity = decimal(e.quantity, 6), gross = decimal(e.grossUsd, 2), fee = decimal(e.feeUsd, 2);
        if (e.kind === 'buy') { cash.USD -= gross + fee; p.quantity += quantity; p.costUsd += gross + fee; }
        else {
          if (quantity > p.quantity) fail('売却数量が保有数量を超えています。');
          const basis = quantity === p.quantity ? p.costUsd : halfUp(p.costUsd * quantity, p.quantity);
          cash.USD += gross - fee;
          p.quantity -= quantity; p.costUsd -= basis; p.realizedPnlUsd += gross - fee - basis;
        }
      }
      bounded(p.quantity); bounded(p.costUsd); bounded(p.realizedPnlUsd, true);
    }
    if (cash.JPY < 0n || cash.USD < 0n) fail('記録時点の現金残高が不足しています。');
    bounded(cash.JPY); bounded(cash.USD);
  }
  return {initialized: l !== null, opening: l?.opening ?? null, monthlyPlanJpy: l?.monthlyPlanJpy ?? '0',
    cash: {JPY: format(cash.JPY, 0), USD: format(cash.USD, 2)}, entries,
    positions: positions.map(p => ({symbol: p.symbol, quantity: format(p.quantity, 6), costUsd: format(p.costUsd, 2), realizedPnlUsd: format(p.realizedPnlUsd, 2),
      averageCostUsd: p.quantity ? format(halfUp(p.costUsd * 100_000_000n, p.quantity), 4) : null}))};
}

export function applyPortfolioChange(current: Ledger | null, change: unknown, entryId: string, today: string): Ledger {
  date(today, '9999-12-31');
  const c = object(change);
  const required = c.type === 'initialize' ? ['opening', 'monthlyPlanJpy'] : c.type === 'opening' ? ['opening'] :
    c.type === 'plan' ? ['monthlyPlanJpy'] : c.type === 'add' ? ['entry'] : c.type === 'edit' ? ['id', 'entry'] :
    c.type === 'void' || c.type === 'restore' ? ['id'] : fail();
  fields(c, ['type', ...required]);
  let next: Ledger;
  if (c.type === 'initialize') {
    if (current !== null) return fail('台帳はすでに開始されています。');
    next = {schemaVersion: 1, opening: opening(c.opening, today), monthlyPlanJpy: normalized(c.monthlyPlanJpy, 0), entries: []};
  } else {
    if (current === null) return fail('先に開始残高を設定してください。');
    next = ledger(current, today);
    replay(next);
    if (c.type === 'opening') next.opening = opening(c.opening, today);
    else if (c.type === 'plan') next.monthlyPlanJpy = normalized(c.monthlyPlanJpy, 0);
    else if (c.type === 'add') {
      if (next.entries.length >= 500) return fail('記録は500件までです。');
      const key = id(entryId);
      if (next.entries.some(e => e.id === key)) return fail('記録の識別子が重複しています。');
      next.entries.push({...input(c.entry, today), id: key, voided: false});
    } else {
      const key = id(c.id), index = next.entries.findIndex(e => e.id === key);
      if (index < 0) return fail('対象の記録が見つかりません。');
      const previous = next.entries[index];
      next.entries[index] = c.type === 'edit' ? {...input(c.entry, today), id: key, voided: previous.voided} : {...previous, voided: c.type === 'void'};
    }
  }
  next = ledger(next, today);
  replay(next);
  return next;
}

export function portfolioView(current: Ledger | null): PortfolioView {
  return replay(current === null ? null : ledger(current, '9999-12-31'));
}
