import {prioritizeNews,PRIORITY_VERSION} from '../domain/news-priority.ts';
import type {NewsSource} from '../domain/news.ts';
import type {Env} from './types.ts';
import {jstDay,pushConfigured,sendNotificationPush} from './push.ts';
type Row={id:string;fingerprint:string;source:NewsSource;title:string;published_at:string;updated_at:string|null;symbols:string;observed_at:string;status:string;success_at:string};
const selection=`SELECT n.id,n.fingerprint,n.source,n.title,n.published_at,n.updated_at,r.symbols,r.observed_at,s.status,s.success_at FROM news_items n JOIN news_revisions r ON r.id=n.id AND r.fingerprint=n.fingerprint JOIN news_sources s ON s.source=n.source`;
function eligible(r:Row,now:Date){return r.status==='ok'&&Date.parse(r.success_at)<=+now&&Date.parse(r.success_at)>=+now-2*3600000&&Date.parse(r.observed_at)<=+now&&Date.parse(r.observed_at)>=+now-2*3600000;}
function priority(r:Row,now:Date){return prioritizeNews({title:r.title,source:r.source,publishedAt:r.published_at,updatedAt:r.updated_at,symbols:JSON.parse(r.symbols)},now);}
export async function queueNewsAlert(env:Env,now=new Date()){
 if(!pushConfigured(env))return {queued:false};
 const rows=await env.DB.prepare(selection+` WHERE n.published_at>=? AND r.observed_at>=(SELECT enabled_at FROM news_alert_settings WHERE id=1) ORDER BY n.published_at DESC LIMIT 40`).bind(new Date(+now-86400000).toISOString()).all<Row>();
 const candidates=rows.results.filter(r=>eligible(r,now)).map(r=>({r,p:priority(r,now)})).filter(c=>c.p.level==='critical'&&c.p.concern&&c.p.eventKey).sort((a,b)=>b.p.score-a.p.score||b.r.published_at.localeCompare(a.r.published_at));
 for(const {r,p} of candidates){
  const family=p.eventKey!.slice(0,p.eventKey!.lastIndexOf(':'))+':%';
  const result=await env.DB.prepare(`INSERT OR IGNORE INTO news_alerts(event_key,article_id,fingerprint,rule_version,created_at,status)
    SELECT ?,?,?,?,?,'pending' WHERE EXISTS(SELECT 1 FROM push_subscription WHERE id=1)
    AND NOT EXISTS(SELECT 1 FROM daily_notifications WHERE day=?)
    AND NOT EXISTS(SELECT 1 FROM news_alerts WHERE status IN ('pending','claimed'))
    AND NOT EXISTS(SELECT 1 FROM news_alerts WHERE event_key LIKE ? AND created_at>=?)`)
    .bind(p.eventKey,r.id,r.fingerprint,PRIORITY_VERSION,now.toISOString(),jstDay(now),family,new Date(+now-72*3600000).toISOString()).run();
  if(result.meta.changes===1)return {queued:true};
 }
 return {queued:false};
}
export async function processNewsAlerts(env:Env,now=new Date(),sender=sendNotificationPush){
 const jobs=await env.DB.prepare(`UPDATE news_alerts SET status='claimed' WHERE event_key IN (SELECT event_key FROM news_alerts WHERE status='pending' ORDER BY created_at LIMIT 1) RETURNING event_key,article_id,fingerprint,rule_version,created_at`).all<{event_key:string;article_id:string;fingerprint:string;rule_version:string;created_at:string}>();
 for(const job of jobs.results){
  let state='skipped',detail='更新・期限・取得状態を再確認できないため通知を見送りました。';
  try{
   const r=await env.DB.prepare(selection+' WHERE n.id=? AND n.fingerprint=?').bind(job.article_id,job.fingerprint).first<Row>();
   const p=r?priority(r,now):null;
   if(r&&eligible(r,now)&&job.rule_version===PRIORITY_VERSION&&+now-Date.parse(job.created_at)<=30*60000&&p?.level==='critical'&&p.concern&&p.eventKey===job.event_key){
    const reserved=await env.DB.prepare(`INSERT OR IGNORE INTO daily_notifications(day,job_id) SELECT ?,? WHERE EXISTS(SELECT 1 FROM news_items n JOIN news_sources s ON s.source=n.source WHERE n.id=? AND n.fingerprint=? AND s.status='ok' AND s.success_at>=?)`).bind(jstDay(now),'news:'+job.event_key,r.id,r.fingerprint,new Date(+now-2*3600000).toISOString()).run();
    detail='本日の自動通知枠は使用済みです。';
    if(reserved.meta.changes===1){
     const direction={positive:'好材料候補',negative:'悪材料候補',mixed:'良悪混在',unknown:'影響方向未判定'}[p.direction];
     // Never release the daily reservation on ambiguous delivery failures.
     detail=(await sender(env,'news:'+job.event_key,{title:`ETF重要ニュース · ${direction}`,body:`${p.reason}。${r.title.slice(0,160)}（見出しによる推定）`,url:'/#news'})).detail;
     state='accepted';
    }
   }
  }catch{state='failed';detail='重要ニュース通知の結果を確認できません。重複防止のため自動再送しません。';}
  await env.DB.prepare('UPDATE news_alerts SET status=?,detail=? WHERE event_key=?').bind(state,detail,job.event_key).run();
 }
 return jobs.results.length>0;
}
