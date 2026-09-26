import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {readFileSync} from 'node:fs';
import {queueNewsAlert,processNewsAlerts} from '../src/server/news-alerts.ts';import {refreshNews} from '../src/server/news.ts';import {jstDay} from '../src/server/push.ts';import type{Env}from'../src/server/types.ts';
function fixture(){
 const db=new DatabaseSync(':memory:');for(const file of ['0001_validation.sql','0009_news.sql','0010_news_alerts.sql'])db.exec(readFileSync(new URL('../migrations/'+file,import.meta.url),'utf8'));
 function prepare(sql:string){let args:any[]=[];const s={bind(...a:any[]){args=a;return s;},async first(){return db.prepare(sql).get(...args)??null;},async all(){return{results:db.prepare(sql).all(...args)};},execute(){const r=db.prepare(sql).run(...args);return{meta:{changes:Number(r.changes)}};},async run(){return s.execute();}};return s;}
 const env={VAPID_PUBLIC_KEY:'fixture',VAPID_PRIVATE_KEY:'fixture',VAPID_SUBJECT:'fixture',ALPACA_API_KEY:'fixture',ALPACA_API_SECRET:'fixture',DB:{prepare,async batch(ss:ReturnType<typeof prepare>[]){db.exec('BEGIN');try{const r=ss.map(s=>s.execute());db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}}}as unknown as Env;
 const now=new Date('2026-09-27T14:00:00Z');db.prepare('UPDATE news_alert_settings SET enabled_at=?').run(new Date(+now-3600000).toISOString());db.exec("INSERT INTO push_subscription VALUES(1,'fixture','fixture','fixture','fixture')");
 const insert=async(title='Nvidia cuts quarterly revenue guidance',offset=0,url='fixture',publishedAt='2026-09-27T13:00:00Z')=>{const date=new Date(+now+offset);await refreshNews(env,'alpaca',date,(async()=>Response.json({news:[{headline:title,url:'https://www.benzinga.com/news/'+url,source:'benzinga',created_at:publishedAt,updated_at:null,symbols:['NVDA']}]}))as typeof fetch,()=>date);};
 let sent=0;const sender=async(_env:Env,_tag:string,p:{title:string;body:string;url:string})=>{sent++;assert.equal(p.url,'/#news');assert.match(p.body,/見出し/);return{ok:true,detail:'fixture accepted'};};
 return{db,env,now,insert,sender,sent:()=>sent};
}
test('concurrent selection and delivery notify once, reserve shared daily limit',async t=>{
 const f=fixture();t.after(()=>f.db.close());await f.insert();await Promise.all([queueNewsAlert(f.env,f.now),queueNewsAlert(f.env,f.now)]);
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM news_alerts').get()!.n,1);
 await Promise.all([processNewsAlerts(f.env,f.now,f.sender),processNewsAlerts(f.env,f.now,f.sender)]);assert.equal(f.sent(),1);
 assert.equal(f.db.prepare('SELECT status FROM news_alerts').get()!.status,'accepted');assert.equal(f.db.prepare('SELECT day FROM daily_notifications').get()!.day,jstDay(f.now));
});
test('existing daily reservation prevents both queue and send; ambiguous errors are never retried',async t=>{
 const f=fixture();t.after(()=>f.db.close());await f.insert();await queueNewsAlert(f.env,f.now);f.db.prepare('INSERT INTO daily_notifications VALUES (?,?)').run(jstDay(f.now),'test');await processNewsAlerts(f.env,f.now,f.sender);assert.equal(f.sent(),0);
 f.db.exec('DELETE FROM daily_notifications;DELETE FROM news_alerts');await queueNewsAlert(f.env,f.now);let attempts=0;await processNewsAlerts(f.env,f.now,async()=>{attempts++;throw Error('secret error');});await processNewsAlerts(f.env,f.now,f.sender);assert.equal(attempts,1);assert.equal(f.sent(),0);assert.equal(f.db.prepare('SELECT count(*) AS n FROM daily_notifications').get()!.n,1);assert.ok(!JSON.stringify(f.db.prepare('SELECT * FROM news_alerts').all()).includes('secret error'));
});
test('pre-activation history, old news, failed sources and missing subscription are ineligible',async t=>{
 const f=fixture();t.after(()=>f.db.close());await f.insert();f.db.prepare('UPDATE news_alert_settings SET enabled_at=?').run(new Date(+f.now+1).toISOString());assert.equal((await queueNewsAlert(f.env,f.now)).queued,false);
 f.db.exec("UPDATE news_alert_settings SET enabled_at='2020-01-01T00:00:00Z';UPDATE news_sources SET status='failed'");assert.equal((await queueNewsAlert(f.env,f.now)).queued,false);
 f.db.exec("UPDATE news_sources SET status='ok';DELETE FROM push_subscription");assert.equal((await queueNewsAlert(f.env,f.now)).queued,false);
 assert.equal((await queueNewsAlert(f.env,new Date(+f.now+25*3600000))).queued,false);
});
test('revised, stale and expired queued candidates are rechecked before any send',async t=>{
 for(const mode of ['revised','source','expired']){
 const f=fixture();t.after(()=>f.db.close());await f.insert();await queueNewsAlert(f.env,f.now);
 if(mode==='revised')await f.insert('Nvidia denies guidance cuts',1000);if(mode==='source')f.db.exec("UPDATE news_sources SET status='failed'");
 await processNewsAlerts(f.env,mode==='expired'?new Date(+f.now+31*60000):f.now,f.sender);assert.equal(f.sent(),0);assert.equal(f.db.prepare('SELECT count(*) AS n FROM daily_notifications').get()!.n,0);
 }
});
test('same material reported again the next day is suppressed for 72 hours',async t=>{
 const f=fixture();t.after(()=>f.db.close());await f.insert();await queueNewsAlert(f.env,f.now);await processNewsAlerts(f.env,f.now,f.sender);
 const next=new Date(+f.now+86400000);await f.insert('Nvidia cuts quarterly revenue guidance',86400000,'another',new Date(+next-3600000).toISOString());assert.equal((await queueNewsAlert(f.env,next)).queued,false);
});
test('hourly 40-minute cron queues once without sending or changing price processing',async t=>{
 const f=fixture();t.after(()=>f.db.close());await f.insert();f.env.OWNER_TOKEN_HASH='fixture';f.env.ENABLE_SCHEDULED_CHECKS='true';
 const {scheduledRun}=await import('../src/server/index.ts');const at=new Date(+f.now+40*60000);await scheduledRun(f.env,at);await scheduledRun(f.env,at);
 assert.equal(f.db.prepare("SELECT count(*) AS n FROM news_alerts WHERE status='pending'").get()!.n,1);assert.equal(f.db.prepare('SELECT count(*) AS n FROM daily_notifications').get()!.n,0);
});
test('good news and speculative adverse news never queue notifications',async t=>{
 for(const headline of ['Nvidia raises quarterly revenue guidance','Nvidia may cut quarterly revenue guidance','Nvidia denies guidance cuts']){
 const f=fixture();t.after(()=>f.db.close());await f.insert(headline);assert.equal((await queueNewsAlert(f.env,f.now)).queued,false,headline);
 }
});
