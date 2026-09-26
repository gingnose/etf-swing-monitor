import test from 'node:test';
import assert from 'node:assert/strict';
import {indicators,buildSnapshots} from '../src/domain/indicators.ts';
import {validateCalendar} from '../src/server/history.ts';
import type {Bar} from '../src/server/types.ts';
test('SMA warmup, 20-session return needs 21 closes, Wilder RSI reference',()=>{
  const rising=Array.from({length:200},(_,i)=>i+1);
  const m=indicators(rising);
  assert.equal(m.sma20,190.5);assert.equal(m.sma50,175.5);assert.equal(m.sma200,100.5);
  assert.ok(Math.abs(m.return20Pct!-100/9)<1e-9);assert.equal(m.rsi14,100);assert.equal(m.drawdown63Pct,0);
  assert.equal(indicators(rising.slice(0,199)).sma200,null);
  assert.equal(indicators(rising.slice(0,20)).return20Pct,null);
  assert.equal(indicators(rising.slice(0,14)).rsi14,null);
  const reference=[44.34,44.09,44.15,43.61,44.33,44.83,45.10,45.42,45.84,46.08,45.89,46.03,45.61,46.28,46.28,46,46.03,46.41,46.22,45.64];
  assert.ok(Math.abs(indicators(reference.slice(0,15)).rsi14!-70.464135)<0.00001);
  assert.ok(Math.abs(indicators(reference).rsi14!-57.915021)<0.00001);
});
test('Flat/declining prices and peak leaving 63-bar window',()=>{
  assert.equal(indicators(Array(70).fill(100)).rsi14,50);
  assert.equal(indicators(Array.from({length:70},(_,i)=>100-i)).rsi14,0);
  assert.equal(indicators([200,...Array(62).fill(100)]).drawdown63Pct,-50);
  assert.equal(indicators([200,...Array(63).fill(100)]).drawdown63Pct,0);
  assert.equal(indicators([]).sma20,null);
  for(const price of [0,-1,NaN,Infinity])assert.throws(()=>indicators([price]));
});
const now=new Date('2026-09-26T12:00:00Z');
const dates=['2026-09-23','2026-09-24','2026-09-25'];
const bars:Bar[]=['SOXL','TQQQ'].flatMap(symbol=>dates.map((d,i)=>({symbol,timestamp:d+'T04:00:00Z',close:100+i,volume:100,feed:'sip' as const})));
test('Snapshot sorts, rejects duplicates and mismatched/missing trading dates',()=>{
 const snapshots=buildSnapshots([...bars].reverse(),now);
 assert.equal(snapshots[0].closes[0].close,100);
 assert.throws(()=>buildSnapshots([...bars,bars[0]],now));
 assert.throws(()=>buildSnapshots(bars.slice(1),now));
 validateCalendar(snapshots,{dates:[...dates,'2026-09-28'],today:'2026-09-26'});
 assert.throws(()=>validateCalendar(snapshots,{dates:['2026-09-22',...dates],today:'2026-09-26'}));
 // A consistent replacement split basis scales prices, preserving returns.
 const split=buildSnapshots(bars.map(b=>({...b,close:b.close/2})),now);
 assert.equal(split[0].closes[0].close,snapshots[0].closes[0].close/2);
});

test('Calendar refuses a truncated future horizon and missing credentials',async()=>{
 const {fetchCalendar}=await import('../src/server/history.ts');
 const start=Date.parse('2025-08-22T00:00:00Z');
 const dates=Array.from({length:415},(_,i)=>new Date(start+i*86400_000)).filter(d=>d.getUTCDay()!==0&&d.getUTCDay()!==6).map(d=>({date:d.toISOString().slice(0,10)}));
 const env={ALPACA_API_KEY:'fixture',ALPACA_API_SECRET:'fixture'};
 const result=await fetchCalendar(env,now,(async()=>Response.json(dates)) as typeof fetch);
 assert.equal(result.through,dates.at(-1)!.date);
 await assert.rejects(fetchCalendar(env,now,(async()=>Response.json(dates.filter(d=>d.date<'2026-09-26'))) as typeof fetch),/将来分/);
 await assert.rejects(fetchCalendar({},now,(async()=>{throw Error('should not fetch');}) as typeof fetch),/未設定/);
});
