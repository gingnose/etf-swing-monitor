import test from 'node:test';import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';import {readFileSync} from 'node:fs';
import type {Env} from '../src/server/types.ts';
import {scheduledRun} from '../src/server/index.ts';
import {currentPriceRules,observePriceRules,readPriceRules} from '../src/server/price-rules.ts';
function fixture(){
  const db=new DatabaseSync(':memory:');
  for(const f of ['0001_validation.sql','0002_history.sql','0003_calendar.sql','0004_history_timing.sql','0008_price_observations.sql'])db.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));
  const now=new Date('2026-09-26T12:00:00Z');
  const dates:string[]=[];for(let d=new Date('2026-09-25');dates.length<230;d.setUTCDate(d.getUTCDate()-1))if(![0,6].includes(d.getUTCDay()))dates.unshift(d.toISOString().slice(0,10));
  const snapshots=['SOXL','TQQQ'].map(symbol=>({symbol,asOf:dates.at(-1),feed:'sip',adjustment:'split',closes:dates.map((date,i)=>({date,close:100+i*.2+Math.sin(i*.4)*4}))}));
  const data={snapshots,calendar:{dates:[...dates,'2026-09-28'],through:'2026-10-09'},latestBars:[]};
  function save(){db.prepare("INSERT INTO market_history VALUES('sip',?,'2026-09-25','hash-one',?) ON CONFLICT(feed) DO UPDATE SET payload=excluded.payload").run(now.toISOString(),JSON.stringify(data));}
  save();db.prepare("INSERT INTO runs VALUES('fixture','success',?,'fixture')").run(now.toISOString());
  function prepare(sql:string){let args:any[]=[];const s={bind(...a:any[]){args=a;return s;},async first(){return db.prepare(sql).get(...args)??null;},async all(){return{results:db.prepare(sql).all(...args)};},async run(){const r=db.prepare(sql).run(...args);return{meta:{changes:Number(r.changes)}};}};return s;}
  return{db,env:{DB:{prepare},ALPACA_FEED:'sip'} as unknown as Env,now,data,save};
}
test('first observation is immutable under duplicate/concurrent requests and revised prices',async t=>{
  const f=fixture();t.after(()=>f.db.close());
  const results=await Promise.all([observePriceRules(f.env,f.now),observePriceRules(f.env,f.now)]);
  assert.equal(results.filter(r=>r.recorded).length,1);
  const first=(await readPriceRules(f.env,f.now)).observations;
  f.data.snapshots[0].closes.at(-1)!.close*=.5;f.save();
  assert.equal((await observePriceRules(f.env,new Date(f.now.getTime()+1000))).recorded,false);
  assert.deepEqual((await readPriceRules(f.env,f.now)).observations,first);
  assert.notDeepEqual((await currentPriceRules(f.env,f.now)).decisions,first[0].decisions);
});
test('failed or stale data suppresses current decisions and cannot create observations',async t=>{
  const f=fixture();t.after(()=>f.db.close());await observePriceRules(f.env,f.now);
  f.db.exec("UPDATE runs SET status='failed'");
  assert.deepEqual((await currentPriceRules(f.env,f.now)).decisions,[]);
  await assert.rejects(observePriceRules(f.env,f.now));
  f.db.exec("UPDATE runs SET status='success'");
  assert.equal((await readPriceRules(f.env,new Date('2026-09-29T12:00:00Z'))).state,'stale');
  assert.equal((await readPriceRules(f.env,new Date('2026-09-29T12:00:00Z'))).observations.length,1);
});
test('insufficient samples and non-SIP feed never enter the observation ledger',async t=>{
  const f=fixture();t.after(()=>f.db.close());
  f.data.snapshots.forEach(s=>s.closes=s.closes.slice(-100));f.save();
  assert.ok((await currentPriceRules(f.env,f.now)).decisions.every(d=>d.state==='insufficient'));
  await assert.rejects(observePriceRules(f.env,f.now));
  f.data.snapshots[0].feed='iex';f.save();
  await assert.rejects(currentPriceRules(f.env,f.now));
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM price_rule_observations').get()!.n,0);
});

test('the separate scheduled observation stage is idempotent and never queues a buy notification',async t=>{
  const f=fixture();t.after(()=>f.db.close());
  const env={...f.env,OWNER_TOKEN_HASH:'fixture',ENABLE_SCHEDULED_CHECKS:'true'};
  const now=new Date('2026-09-26T12:20:00Z');
  await scheduledRun(env,now);await scheduledRun(env,now);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM price_rule_observations').get()!.n,1);
  assert.equal(f.db.prepare('SELECT COUNT(*) AS n FROM notification_jobs').get()!.n,0);
});
