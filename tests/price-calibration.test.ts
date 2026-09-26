import test from 'node:test';import assert from 'node:assert/strict';
import {features,quantile,RULES,START,matches,study} from '../src/domain/price-calibration.ts';
function rows(n:number){let d=new Date('2020-01-01T00:00:00Z');return Array.from({length:n},(_,i)=>{while([0,6].includes(d.getUTCDay()))d.setUTCDate(d.getUTCDate()+1);const date=d.toISOString().slice(0,10);d.setUTCDate(d.getUTCDate()+1);return{date,close:100+i*.1+Math.sin(i/3)*5};});}
test('20-price population deviation matches independent formula; price units do not change score',()=>{
 const r=rows(300),f=features(r),scaled=features(r.map(x=>({...x,close:x.close*10}))),i=299;
 const window=r.slice(i-19,i+1).map(x=>x.close),m=window.reduce((a,b)=>a+b)/20,variance=window.reduce((s,x)=>s+(x-m)**2,0)/20;
 assert.ok(Math.abs(f[i].z!-(r[i].close-m)/Math.sqrt(variance))<1e-10);assert.ok(Math.abs(f[i].z!-scaled[i].z!)<1e-10);
 assert.ok(Math.abs(f[i].logZ!-scaled[i].logZ!)<1e-10);assert.equal(f[18].z,null);
});
test('rank uses 252 prior gaps only; all features are invariant to future observations',()=>{
 const r=rows(340),f=features(r);assert.deepEqual(features(r.slice(0,300)),f.slice(0,300));assert.equal(f[START-1].rank,null);
 const gaps=f.slice(START-252,START).map(x=>x.gap),v=f[START].gap;
 assert.equal(f[START].rank,(gaps.filter(x=>x<v).length+.5*gaps.filter(x=>x===v).length)/252);
 const changed=features(r.map((x,i)=>i>300?{...x,close:x.close*7}:x));assert.deepEqual(changed.slice(0,301),f.slice(0,301));
});
test('constant paths abstain on zero scales and tie ranks remain neutral',()=>{
 const f=features(rows(300).map(x=>({...x,close:100})));assert.equal(f[299].z,null);assert.equal(f[299].logZ,null);assert.equal(f[299].robustZ,null);assert.equal(f[299].rank,.5);
 assert.equal(quantile([1,2,3,4],.5),2.5);assert.equal(quantile([],.5),null);
});
test('execution begins next close, costs and path loss include entry, overlapping signals skipped',()=>{
 const r=rows(300).map((x,i)=>({...x,close:100+i})),f=features(r).map(x=>({...x,z:-2.1}));
 const out=study(r,f,r[START].date,r[START+4].date,2,RULES[0],.5);
 assert.equal(out.completed,1);assert.equal(out.events[0].entryDate,r[START+1].date);assert.equal(out.events[0].exitDate,r[START+3].date);
 assert.ok(Math.abs(out.meanPct!-((r[START+3].close/r[START+1].close-1)*100-.5))<1e-10);assert.equal(out.events[0].worstPathPct,-.5);assert.equal(out.overlapSkipped,3);assert.equal(out.pending,1);
 const changed=r.map((x,i)=>i>START+4?{...x,close:1}:x);assert.deepEqual(study(changed,features(changed).map(x=>({...x,z:-2.1})),r[START].date,r[START+4].date,2,RULES[0],.5),out);
});
test('trend gating and re-entry are separate from a band touch',()=>{
 const f=features(rows(300)).map(x=>({...x,z:-2.2,trend:true}));assert.equal(matches(f,START,RULES[0]),true);assert.equal(matches(f,START,RULES[2]),false);
 f[START].z=-1.9;assert.equal(matches(f,START,RULES[2]),true);f[START].trend=false;assert.equal(matches(f,START,RULES[2]),false);
 assert.equal(matches(f,START-1,RULES[0]),false);
});
