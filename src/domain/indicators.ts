import type { Bar } from '../server/types.ts';

export const INDICATOR_VERSION = 'close-indicators-v1';
export type Metrics = { sma20: number | null; sma50: number | null; sma200: number | null; rsi14: number | null; return20Pct: number | null; drawdown63Pct: number | null };
export function indicators(closes: readonly number[]): Metrics {
  if (closes.some(n => !Number.isFinite(n) || n <= 0)) throw new Error('Invalid close');
  const mean = (n: number) => closes.length < n ? null : closes.slice(-n).reduce((a, b) => a + b, 0) / n;
  let rsi: number | null = null;
  if (closes.length >= 15) {
    let gain = 0, loss = 0;
    for (let i = 1; i <= 14; i++) { const delta = closes[i] - closes[i-1]; gain += Math.max(delta, 0) / 14; loss += Math.max(-delta, 0) / 14; }
    for (let i = 15; i < closes.length; i++) { const delta = closes[i] - closes[i-1]; gain = (gain * 13 + Math.max(delta, 0)) / 14; loss = (loss * 13 + Math.max(-delta, 0)) / 14; }
    // Flat series is neutral by convention, documented alongside this version.
    rsi = gain === 0 && loss === 0 ? 50 : loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  const last = closes.at(-1);
  return { sma20: mean(20), sma50: mean(50), sma200: mean(200), rsi14: rsi,
    return20Pct: closes.length >= 21 ? (last! / closes[closes.length - 21] - 1) * 100 : null,
    drawdown63Pct: closes.length >= 63 ? (last! / Math.max(...closes.slice(-63)) - 1) * 100 : null };
}
export type Snapshot = { symbol: string; asOf: string; retrievedAt: string; start: string; count: number; feed: string; adjustment: 'split'; metrics: Metrics; closes: { date: string; close: number }[] };
export function buildSnapshots(bars: Bar[], retrievedAt: Date, requestedSymbols: readonly string[] = ['SOXL', 'TQQQ']): Snapshot[] {
  const snapshots = requestedSymbols.map(symbol => {
    const rows = bars.filter(b => b.symbol === symbol).sort((a, b) => a.timestamp < b.timestamp ? -1 : a.timestamp > b.timestamp ? 1 : 0);
    if (!rows.length || rows.length > 1200) throw new Error('Invalid history size');
    const dates = rows.map(b => b.timestamp.slice(0, 10));
    if (new Set(dates).size !== dates.length) throw new Error('Duplicate market date');
    if (rows.some(b => b.feed !== rows[0].feed)) throw new Error('Mixed data feeds');
    for (let i=1; i<rows.length; i++) if (Date.parse(rows[i].timestamp)-Date.parse(rows[i-1].timestamp)>7*86400_000) throw new Error('Large history gap');
    return { symbol, asOf: dates.at(-1)!, retrievedAt: retrievedAt.toISOString(), start: dates[0], count: rows.length, feed: rows[0].feed, adjustment: 'split' as const,
      metrics: indicators(rows.map(b => b.close)), closes: rows.map((b,i) => ({ date: dates[i], close: b.close })) };
  });
  if (snapshots.length===2 && (snapshots[0].feed !== snapshots[1].feed || JSON.stringify(snapshots[0].closes.map(b=>b.date)) !== JSON.stringify(snapshots[1].closes.map(b=>b.date)))) throw new Error('Mismatched trading dates');
  return snapshots;
}
