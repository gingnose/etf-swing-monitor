import test from 'node:test';
import assert from 'node:assert/strict';
import { barsUrl, fetchDailyBars, nyDate, parseBars } from '../src/server/market.ts';

const now = new Date('2026-09-26T12:00:00Z');
const bar = { t: '2026-09-25T04:00:00Z', c: 100, v: 12345 };
test('日足リクエストは当日のNY日付と直近15分を除外しSIPを指定', () => {
  for (const date of [now, new Date('2026-01-08T01:00:00Z'), new Date('2026-07-04T00:05:00Z')]) {
    const url = barsUrl(date, 'sip');
    assert.equal(url.searchParams.get('feed'), 'sip');
    assert.equal(url.searchParams.get('adjustment'), 'split');
    assert.equal(url.searchParams.get('symbols'), 'SOXL,TQQQ');
    const end = new Date(url.searchParams.get('end')!);
    assert.ok(end.getTime() < date.getTime() - 15 * 60_000);
    assert.ok(nyDate(end) < nyDate(date));
  }
});
test('ページ分割された両銘柄を取得し認証情報を固定APIだけへ送る', async () => {
  let calls = 0;
  const bars = await fetchDailyBars({ ALPACA_API_KEY: 'fixture', ALPACA_API_SECRET: 'fixture' }, now, (async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://data.alpaca.markets');
    assert.equal(init?.redirect, 'error');
    assert.equal(new Headers(init?.headers).get('APCA-API-KEY-ID'), 'fixture');
    calls++;
    if (calls === 1) return Response.json({ bars: { SOXL: [bar] }, next_page_token: 'next' });
    assert.equal(url.searchParams.get('page_token'), 'next');
    return Response.json({ bars: { TQQQ: [bar] }, next_page_token: null });
  }) as typeof fetch);
  assert.equal(calls, 2);
  assert.deepEqual(bars.map(b => b.symbol), ['SOXL', 'TQQQ']);
});
test('欠けた銘柄や古い価格は成功にしない', async () => {
  for (const payload of [
    { bars: { SOXL: [bar] } },
    { bars: { SOXL: [{ ...bar, t: '2026-08-01T04:00:00Z' }], TQQQ: [bar] } },
  ]) await assert.rejects(fetchDailyBars({ ALPACA_API_KEY: 'x', ALPACA_API_SECRET: 'y' }, now, (async () => Response.json(payload)) as typeof fetch));
});
test('API権限エラーでIEXへ黙って切り替えず上流本文を返さない', async () => {
  let calls = 0;
  await assert.rejects(fetchDailyBars({ ALPACA_API_KEY: 'x', ALPACA_API_SECRET: 'y' }, now, (async () => {
    calls++; return new Response('PRIVATE-UPSTREAM-BODY', { status: 403 });
  }) as typeof fetch), error => error instanceof Error && error.message.includes('SIP') && !error.message.includes('PRIVATE'));
  assert.equal(calls, 1);
});
test('現在のNY日付の未確定足を採用しない', () => {
  const parsed = parseBars({ bars: { SOXL: [{ ...bar, t: '2026-09-26T04:00:00Z' }, bar] } }, 'sip', now);
  assert.equal(parsed.bars.length, 1);
  assert.equal(parsed.bars[0].timestamp, bar.t);
});
test('壊れた時刻・負価格・無限大の出来高を拒否', () => {
  for (const broken of [{ ...bar, t: 'invalid' }, { ...bar, c: -1 }, { ...bar, v: Infinity }]) {
    assert.throws(() => parseBars({ bars: { SOXL: [broken] } }, 'sip', now));
  }
});
test('認証未設定では外部APIを呼ばない', async () => {
  await assert.rejects(fetchDailyBars({}, now, (async () => { assert.fail('must not call'); }) as typeof fetch), /未設定/);
});
