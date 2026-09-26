import test from 'node:test';import assert from 'node:assert/strict';
import {entryStrategies} from '../src/domain/entry-strategies.ts';
function rows(values:number[]){let d=new Date('2020-01-01');return values.map(close=>{while([0,6].includes(d.getUTCDay()))d.setUTCDate(d.getUTCDate()+1);const date=d.toISOString().slice(0,10);d.setUTCDate(d.getUTCDate()+1);return{date,close};});}
test('strict prior-20 closing high, ties and incomplete histories',()=>{
 const r=rows([...Array(20).fill(10),11,12,12,13]);
 const result=entryStrategies('SOXL',r);assert.equal(result.breakout.previousHigh,12);assert.equal(result.breakout.matched,true);
 assert.deepEqual([result.frequency!.days,result.frequency!.updates,result.frequency!.episodes],[4,3,2]);
 assert.equal(entryStrategies('SOXL',r.slice(0,20)).breakout.matched,null);
 assert.equal(entryStrategies('SOXL',r.slice(0,23)).breakout.matched,false);
 assert.equal(result.longValue.rankPct,null);
});
test('long rank needs all 756 prior sessions, distinguishes ties, and is unit invariant',()=>{
 const r=rows([...Array.from({length:756},(_,i)=>i+1),75]);const result=entryStrategies('SOXL',r);
 assert.ok(Math.abs(result.longValue.rankPct!-74.5/756*100)<1e-10);assert.equal(result.longValue.matched,true);
 assert.equal(entryStrategies('SOXL',r.slice(1)).longValue.matched,null);
 assert.equal(entryStrategies('SOXL',r.map(x=>({...x,close:x.close*10}))).longValue.rankPct,result.longValue.rankPct);
 assert.equal(entryStrategies('SOXL',rows(Array(757).fill(10))).longValue.matched,false);
 assert.equal(entryStrategies('SOXL',[]).frequency,null);
});
test('future observations do not change past decisions; price validation is retained',()=>{
 const r=rows(Array.from({length:800},(_,i)=>100+i%15));const prefix=r.slice(0,780);
 const before=entryStrategies('TQQQ',prefix);r[799].close=9999;assert.deepEqual(entryStrategies('TQQQ',r.slice(0,780)),before);
 assert.throws(()=>entryStrategies('OTHER',r));assert.throws(()=>entryStrategies('SOXL',rows([0])));
});
