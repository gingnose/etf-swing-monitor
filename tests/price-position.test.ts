import test from 'node:test';import assert from 'node:assert/strict';
import {pricePositions,positionEvents,positionSummary,targetSummary} from '../src/domain/price-position.ts';
function rows(values:number[]){let d=new Date('2020-01-01T00:00:00Z');return values.map(close=>{while([0,6].includes(d.getUTCDay()))d.setUTCDate(d.getUTCDate()+1);const date=d.toISOString().slice(0,10);d.setUTCDate(d.getUTCDate()+1);return {date,close};});}
test('price position excludes today, has neutral ties, distinguishes strict lows, and is scale invariant',()=>{
 const r=rows([10,20,30,40,20,9]),p=pricePositions(r,4);
 assert.equal(p[3],null);assert.equal(p[4]!.rank,.375);assert.equal(p[4]!.newLow,false);assert.equal(p[5]!.rank,0);assert.equal(p[5]!.newLow,true);
 assert.equal(p[4]!.distanceFromLowPct,100);
 assert.deepEqual(pricePositions(r.map(x=>({...x,close:x.close*10})),4),p);
 const flat=pricePositions(rows([10,10,10,10]),3)[3]!;assert.equal(flat.rank,.5);assert.equal(flat.newLow,false);
});
test('positions and anchor selection cannot see future prices',()=>{
 const r=rows(Array.from({length:300},(_,i)=>100+i%7)),p=pricePositions(r,20);
 assert.deepEqual(pricePositions(r.slice(0,100),20),p.slice(0,100));
 const flags=p.map(x=>x!==null&&x.rank<=.1),a=positionEvents(r,flags,20),changed=r.map((x,i)=>i>100?{...x,close:1}:x);
 const b=positionEvents(changed,pricePositions(changed,20).map(x=>x!==null&&x.rank<=.1),20);
 assert.deepEqual(a.filter(e=>e.signalDate<=r[100].date).map(e=>e.signalDate),b.filter(e=>e.signalDate<=r[100].date).map(e=>e.signalDate));
});
test('next close entry, outcome length, costs and fixed spacing are explicit',()=>{
 const r=rows(Array.from({length:280},(_,i)=>100+i));const events=positionEvents(r,r.map(()=>true),0,20,.5);
 assert.equal(events[0].entryDate,r[1].date);assert.equal(events[1].signalDate,r[21].date);assert.equal(events[0].followed,252);
 const out=events[0].outcomes.find(x=>x.horizon===5)!;assert.ok(Math.abs(out.returnPct-((106/101-1)*100-.5))<1e-10);assert.equal(out.worstPathPct,-.5);
 assert.equal(events[0].hitDay,11);
 assert.equal(positionSummary(events,5).n,2);assert.ok(positionSummary(events,5,false).n>2);
 const expensive=positionEvents(r,r.map(()=>true),0,20,1);assert.equal(expensive[0].hitDay,12);
 assert.deepEqual(events.map(e=>e.signalDate),expensive.map(e=>e.signalDate));
});
test('failed targets and incomplete observation are not counted as successful recovery',()=>{
 const r=rows(Array.from({length:280},()=>100)),flags=r.map((_,i)=>[0,260,279].includes(i));
 const events=positionEvents(r,flags,0,0,.5),s=targetSummary(events);
 assert.equal(s.completed,1);assert.equal(s.hit,0);assert.equal(s.notHit,1);assert.equal(s.medianDaysAmongHits,null);assert.equal(s.pending,1);assert.equal(s.awaitingEntry,1);
 assert.equal(positionSummary(events,20).n,1);assert.equal(events[2].entryDate,null);
});
test('early profit in an unfinished path remains pending; a later fall is retained',()=>{
 const values=Array.from({length:280},()=>100);values[2]=111;values[100]=30;values[270]=111;
 const r=rows(values),flags=r.map((_,i)=>i===0||i===260),events=positionEvents(r,flags,0,0,.5),s=targetSummary(events);
 assert.equal(s.hit,1);assert.equal(s.pending,1);assert.equal(s.pendingAlreadyHit,1);assert.equal(s.medianDaysAmongHits,1);
 assert.equal(events[0].outcomes.find(x=>x.horizon===252)!.worstPathPct,-70.5);
 assert.throws(()=>pricePositions(r,0));assert.throws(()=>positionEvents(r,[],0));
});
