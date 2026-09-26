import test from 'node:test';
import assert from 'node:assert/strict';
import {priceDecision,eventStudy,WINDOW,type Close} from '../src/domain/price-rules.ts';
function rows(count=260,fn=(i:number)=>100+i*.2+Math.sin(i*.4)*4):Close[]{
  const dates:string[]=[];
  for(let d=new Date('2025-01-01');dates.length<count;d.setUTCDate(d.getUTCDate()+1)) if(![0,6].includes(d.getUTCDay())) dates.push(d.toISOString().slice(0,10));
  return dates.map((date,i)=>({date,close:fn(i)}));
}
test('205-day warmup, frozen pullback/recovery examples, and weak/overheated gates',()=>{
  assert.equal(priceDecision('SOXL',rows(WINDOW-1)).state,'insufficient');
  assert.deepEqual(priceDecision('SOXL',rows(218)).matched,['pullback']);
  assert.deepEqual(priceDecision('TQQQ',rows(220)).matched,['recovery']);
  assert.equal(priceDecision('SOXL',rows(220,i=>300-i)).state,'pause');
  assert.equal(priceDecision('SOXL',rows(220,i=>100+i)).state,'pause');
});
test('fixed-window decisions cannot see older or future observations',()=>{
  const source=rows(260),prefix=source.slice(0,220);
  assert.deepEqual(priceDecision('SOXL',prefix),priceDecision('SOXL',prefix.slice(-WINDOW)));
  const result=priceDecision('SOXL',prefix);
  source[230].close=99999;
  assert.deepEqual(priceDecision('SOXL',source.slice(0,220)),result);
  assert.equal(result.values?.sma50FiveAgo,prefix.slice(-55,-5).reduce((a,b)=>a+b.close,0)/50);
});
test('reject duplicate, reversed, impossible dates, large gaps, invalid price and symbols',()=>{
  const source=rows();
  for(const bad of [[source[0],source[0]],source.slice().reverse(),[{date:'2025-02-30',close:1}],[source[0],source[10]],[{date:'2025-01-01',close:NaN}],[{date:'2025-01-01',close:0}]])assert.throws(()=>priceDecision('SOXL',bad));
  assert.throws(()=>priceDecision('OTHER',source));
});
test('endpoint study starts next session close, charges stated cost and measures entry-relative loss',()=>{
  const source=rows(216,i=>i<205?100:i===210?150:200);
  const result=eventStudy('SOXL',source,source[0].date,source.at(-1)!.date,10,'baseline',.5);
  assert.equal(result.completed,1);assert.equal(result.meanPct,-.5);assert.equal(result.positivePct,0);assert.equal(result.worstPathPct,-25.5);
});
test('non-overlapping windows and unfinished events are explicit, boundaries are purged',()=>{
  const source=rows(260,i=>100);
  const result=eventStudy('SOXL',source,source[0].date,source.at(-1)!.date,20,'baseline');
  assert.equal(result.completed,2);assert.equal(result.signals,result.completed+result.pending+result.overlapSkipped);
  assert.equal(result.meanPct,0);assert.equal(result.pending,12);
  const cut=eventStudy('SOXL',source,source[0].date,source[214].date,20,'baseline');
  assert.equal(cut.completed,0);assert.equal(cut.meanPct,null);assert.equal(cut.positivePct,null);
  assert.throws(()=>eventStudy('SOXL',source,'2026-01-01','2025-01-01',20,'baseline'));
});
test('future bars beyond a closed evaluation period cannot change its result',()=>{
  const source=rows(260),end=source[239].date;
  const a=eventStudy('SOXL',source,source[0].date,end,10,'pullback');
  for(let i=240;i<source.length;i++)source[i].close=99999;
  assert.deepEqual(eventStudy('SOXL',source,source[0].date,end,10,'pullback'),a);
});
