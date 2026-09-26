import test from 'node:test';import assert from 'node:assert/strict';import {DatabaseSync} from 'node:sqlite';import {readFileSync} from 'node:fs';
import {readNews,refreshNews} from '../src/server/news.ts';import type{Env}from'../src/server/types.ts';
function fixture(){
 const db=new DatabaseSync(':memory:');db.exec(readFileSync(new URL('../migrations/0009_news.sql',import.meta.url),'utf8'));
 function prepare(sql:string){let args:any[]=[];const s={bind(...a:any[]){args=a;return s;},async first(){return db.prepare(sql).get(...args)??null;},async all(){return{results:db.prepare(sql).all(...args)};},execute(){const r=db.prepare(sql).run(...args);return{meta:{changes:Number(r.changes)}};},async run(){return s.execute();}};return s;}
 const env={ALPACA_API_KEY:'fixture',ALPACA_API_SECRET:'fixture',DB:{prepare,async batch(statements:ReturnType<typeof prepare>[]){db.exec('BEGIN');try{const r=statements.map(s=>s.execute());db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}}}as unknown as Env;
 const now=new Date('2026-09-27T00:00:00Z');let title='Nvidia earnings outlook',updated='2026-09-26T15:00:00Z',fail=false;
 const fetcher=(async()=>fail?new Response('private-error',{status:503}):Response.json({news:[{headline:title,url:'https://www.benzinga.com/news/fixture',source:'benzinga',created_at:'2026-09-26T14:00:00Z',updated_at:updated,symbols:['NVDA']}]}))as typeof fetch;
 return{db,env,now,fetcher,change:(v:string)=>{title=v;updated='2026-09-26T16:00:00Z';},fail:()=>{fail=true;}};
}
test('news is private metadata with first-seen and immutable, reproducible revisions',async t=>{
 const f=fixture();t.after(()=>f.db.close());
 await refreshNews(f.env,'alpaca',f.now,f.fetcher,()=>f.now);
 const first=await readNews(f.env,f.now);assert.equal(first.articles.length,1);assert.equal(first.sources[0].state,'current');assert.equal(first.sources[1].state,'unavailable');assert.equal(first.reviewCandidates,1);
 await refreshNews(f.env,'alpaca',new Date(+f.now+1000),f.fetcher,()=>new Date(+f.now+1000));
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM news_revisions').get()!.n,1);
 f.change('Nvidia denies export restrictions');
 await refreshNews(f.env,'alpaca',new Date(+f.now+2000),f.fetcher,()=>new Date(+f.now+2000));
 const next=await readNews(f.env,new Date(+f.now+2000));assert.equal(next.articles[0].firstSeen,first.articles[0].firstSeen);assert.notEqual(next.articles[0].revisionSeen,first.articles[0].revisionSeen);assert.equal(next.articles[0].evidence.direction,'unknown');
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM news_revisions').get()!.n,2);
 assert.equal(f.db.prepare('SELECT symbols FROM news_revisions LIMIT 1').get()!.symbols,'["NVDA"]');
});
test('failed source retains prior articles with failure and freshness warnings',async t=>{
 const f=fixture();t.after(()=>f.db.close());await refreshNews(f.env,'alpaca',f.now,f.fetcher,()=>f.now);
 assert.equal((await readNews(f.env,new Date(+f.now+17*3600000))).sources[0].state,'stale');
 f.fail();await assert.rejects(refreshNews(f.env,'alpaca',new Date(+f.now+1000),f.fetcher));
 const next=await readNews(f.env,f.now);assert.equal(next.sources[0].state,'failed');assert.equal(next.articles.length,1);assert.equal(next.articles[0].sourceState,'failed');assert.ok(!JSON.stringify(next).includes('private-error'));
});
test('older requests cannot replace newer articles or source status',async t=>{
 const f=fixture();t.after(()=>f.db.close());await refreshNews(f.env,'alpaca',f.now,f.fetcher,()=>f.now);
 f.change('An older response');await refreshNews(f.env,'alpaca',new Date(+f.now-1000),f.fetcher,()=>new Date(+f.now+1000));
 const next=await readNews(f.env,f.now);assert.equal(next.articles[0].title,'Nvidia earnings outlook');assert.equal(next.sources[0].lastAttempt,f.now.toISOString());
});
test('article/revision batch rolls back atomically, then records a safe failure',async t=>{
 const f=fixture();t.after(()=>f.db.close());f.db.exec("CREATE TRIGGER deny_item BEFORE INSERT ON news_items BEGIN SELECT RAISE(ABORT,'private-sql-detail'); END;");
 await assert.rejects(refreshNews(f.env,'alpaca',f.now,f.fetcher,()=>f.now));
 assert.equal(f.db.prepare('SELECT count(*) AS n FROM news_revisions').get()!.n,0);
 const next=await readNews(f.env,f.now);assert.equal(next.sources[0].state,'failed');assert.ok(!JSON.stringify(next).includes('private-sql-detail'));
});
test('old articles do not become fresh simply because fetched today; repeated titles are not erased',async t=>{
 const f=fixture();t.after(()=>f.db.close());const fetcher=(async()=>Response.json({news:[1,2].map(n=>({headline:'Federal Reserve issues statement',url:'https://www.benzinga.com/news/'+n,source:'benzinga',created_at:`2026-09-${n===1?'02':'03'}T14:00:00Z`,updated_at:null,symbols:['NVDA']}))}))as typeof fetch;
 await refreshNews(f.env,'alpaca',f.now,fetcher,()=>f.now);const next=await readNews(f.env,f.now);
 assert.equal(next.articles.length,2);assert.equal(next.reviewCandidates,0);assert.equal(next.articles[0].similarHeadlines,0);
});
test('adverse material ranks ahead of positive and reference news before the display limit',async t=>{
 const f=fixture();t.after(()=>f.db.close());const headlines=['Nvidia introduces new game','Nvidia raises quarterly guidance','Nvidia cuts quarterly guidance'];
 const fetcher=(async()=>Response.json({news:headlines.map((headline,n)=>({headline,url:'https://www.benzinga.com/news/'+n,source:'benzinga',created_at:'2026-09-26T20:00:00Z',updated_at:null,symbols:['NVDA']}))}))as typeof fetch;
 await refreshNews(f.env,'alpaca',f.now,fetcher,()=>f.now);const view=await readNews(f.env,f.now);
 assert.equal(view.articles[0].priority.direction,'negative');assert.equal(view.articles[1].priority.direction,'positive');assert.equal(view.articles[2].priority.level,'normal');assert.equal(view.purchaseReview[0].state,'concerns');assert.equal(view.purchaseReview[0].incomplete,true);
});
