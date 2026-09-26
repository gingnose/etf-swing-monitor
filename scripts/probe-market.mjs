import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { readPrivateConfig } from './private-config.mjs';
import { fetchDailyBars } from '../src/server/market.ts';
const root = resolve(import.meta.dirname, '..');
const feed = process.argv[2] || 'sip';
if (!['sip', 'iex'].includes(feed)) { console.error('取得元は sip または iex を指定してください。'); process.exit(1); }
try {
  const values = readPrivateConfig(root);
  const bars = await fetchDailyBars({ ...values, ALPACA_FEED: feed });
  const result = {
    checkedAt: new Date().toISOString(), feed,
    symbols: ['SOXL', 'TQQQ'].map(symbol => {
      const rows = bars.filter(b => b.symbol === symbol).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
      return { symbol, count: rows.length, latest: rows[0] };
    }),
  };
  mkdirSync(resolve(root, 'private'), { recursive: true, mode: 0o700 });
  writeFileSync(resolve(root, 'private/market-probe.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : '接続を確認できませんでした。');
  process.exit(1);
}
