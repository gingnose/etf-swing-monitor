import {summarizeNewsReview} from '../domain/news-review.ts';
import {prioritizeNews,PRIORITY_VERSION} from '../domain/news-priority.ts';
import {SaxesParser} from 'saxes';
import {AppError,type Env} from './types.ts';
import {digest} from './auth.ts';
import {NEWS_SOURCES,NEWS_VERSION,NEWS_QUERY_SYMBOLS,SOURCE_NAMES,normalizeNews,newsEvidence,headlineKey,type NewsSource,type NewsInput,type NewsEvidence} from '../domain/news.ts';
const feeds={fed:'https://www.federalreserve.gov/feeds/press_monetary.xml',nvidia:'https://nvidianews.nvidia.com/releases.xml'};
const MAX_BYTES=192*1024;
export function parseNewsRss(xml:string):NewsInput[]{
  const rows:NewsInput[]=[];const stop=Symbol('bounded RSS prefix');const stack:string[]=[];let item:Record<string,string>|null=null;let rss=false;
  const parser=new SaxesParser({xmlns:false});
  parser.on('doctype',()=>{throw new Error('DTDは許可していません。');});
  parser.on('opentag',tag=>{stack.push(tag.name);if(stack.length>16)throw new Error('RSSの階層が深すぎます。');if(stack.length===1&&tag.name==='rss')rss=true;if(stack.join('/')==='rss/channel/item'){if(rows.length>=100)throw new Error('RSSの記事数が多すぎます。');item={};}});
  const text=(value:string)=>{if(item&&stack.length===4&&['title','link','pubDate'].includes(stack[3])){const key=stack[3];item[key]=(item[key]??'')+value;if(item[key].length>3000)throw new Error('RSSの項目が長すぎます。');}};
  parser.on('text',text);parser.on('cdata',text);
  parser.on('closetag',()=>{if(stack.join('/')==='rss/channel/item'&&item){rows.push({title:item.title??'',url:(item.link??'').trim(),publishedAt:(item.pubDate??'').trim(),updatedAt:null,symbols:[]});item=null;if(rows.length===5)throw stop;}stack.pop();});
  try{parser.write(xml).close();}catch(e){if(e!==stop)throw e;}if(!rss)throw new Error('RSS形式ではありません。');return rows;
}
async function boundedText(response:Response){
  if(Number(response.headers.get('Content-Length')||0)>MAX_BYTES||!response.body)throw new AppError(502,'ニュース応答のサイズが不正です。');
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  try{while(true){const r=await reader.read();if(r.done)break;size+=r.value.byteLength;if(size>MAX_BYTES)throw new AppError(502,'ニュース応答が上限を超えました。');chunks.push(r.value);}}
  finally{await reader.cancel().catch(()=>{});}
  const joined=new Uint8Array(size);let at=0;for(const chunk of chunks){joined.set(chunk,at);at+=chunk.byteLength;}return new TextDecoder('utf-8',{fatal:true}).decode(joined);
}
export async function fetchNews(source:NewsSource,env:Env,now:Date,fetcher:typeof fetch=fetch){
  if(!NEWS_SOURCES.includes(source))throw new AppError(400,'ニュース提供元が不正です。');
  const headers:Record<string,string>={Accept:source==='alpaca'?'application/json':'application/rss+xml,application/xml,text/xml'};
  let url:string;
  if(source==='alpaca'){
    if(!env.ALPACA_API_KEY||!env.ALPACA_API_SECRET)throw new AppError(503,'AlpacaのAPIキーが未設定です。');
    headers['APCA-API-KEY-ID']=env.ALPACA_API_KEY;headers['APCA-API-SECRET-KEY']=env.ALPACA_API_SECRET;
    url='https://data.alpaca.markets/v1beta1/news?'+new URLSearchParams({symbols:NEWS_QUERY_SYMBOLS,limit:'10',include_content:'false',sort:'desc',start:new Date(now.getTime()-7*86400000).toISOString(),end:new Date(now.getTime()-20*60000).toISOString()});
  }else url=feeds[source];
  let response:Response;try{response=await fetcher(url,{headers,redirect:'manual',signal:AbortSignal.timeout(12000)});}catch{throw new AppError(502,'ニュース提供元へ接続できません。');}
  if(!response.ok)throw new AppError(502,`ニュース取得を保留しました（HTTP ${response.status}）。`);
  const text=await boundedText(response);
  let inputs:NewsInput[],limited=false;
  try{
    if(source==='alpaca'){
      const data=JSON.parse(text);if(!Array.isArray(data.news)||data.news.length>10)throw new Error();
      inputs=data.news.map((r:Record<string,unknown>)=>{if(r.source!=='benzinga')throw new Error('未対応の配信元です。');return {title:r.headline,url:r.url,publishedAt:r.created_at,updatedAt:r.updated_at,symbols:r.symbols};});
      limited=Boolean(data.next_page_token);
    }else{inputs=parseNewsRss(text);limited=true;}
  }catch{throw new AppError(502,'ニュースの形式・配信元を確認できません。');}
  const seen=new Set<string>();let rejected=0;const articles:{item:NewsInput;evidence:NewsEvidence}[]=[];
  for(const raw of inputs){
    try{
      const item=normalizeNews(raw,source,now);
      if(Date.parse(item.publishedAt)<now.getTime()-30*86400000)continue;
      const evidence=newsEvidence(item,source);if(!evidence.targets.length)continue;
      if(seen.has(item.url))continue;seen.add(item.url);articles.push({item,evidence});
    }catch{rejected++;}
  }
  if(rejected&&articles.length===0)throw new AppError(502,'取得記事の出所・日時を確認できません。');
  if(articles.length>20||rejected)limited=true;
  return {articles:articles.slice(0,20),limited,rejected};
}
export async function refreshNews(env:Env,source:NewsSource,now=new Date(),fetcher:typeof fetch=fetch,clock:()=>Date=()=>new Date()){
  const requestAt=now.toISOString();
  try{
    const result=await fetchNews(source,env,now,fetcher),observedAt=clock().toISOString();
    const statements:D1PreparedStatement[]=[];
    for(const {item,evidence} of result.articles){
      const id=await digest(source+'\n'+item.url),payload=JSON.stringify(evidence);
      const fingerprint=await digest(JSON.stringify({item,evidence}));
      statements.push(env.DB.prepare(`INSERT OR IGNORE INTO news_revisions(id,fingerprint,observed_at,title,published_at,updated_at,evidence,symbols) VALUES (?,?,?,?,?,?,?,?)`).bind(id,fingerprint,observedAt,item.title,item.publishedAt,item.updatedAt,payload,JSON.stringify(item.symbols)));
      statements.push(env.DB.prepare(`INSERT INTO news_items(id,source,url,title,published_at,updated_at,first_seen,last_seen,request_at,fingerprint,headline_key,evidence) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title,published_at=excluded.published_at,updated_at=excluded.updated_at,last_seen=excluded.last_seen,request_at=excluded.request_at,fingerprint=excluded.fingerprint,headline_key=excluded.headline_key,evidence=excluded.evidence
        WHERE excluded.request_at>=news_items.request_at`).bind(id,source,item.url,item.title,item.publishedAt,item.updatedAt,observedAt,observedAt,requestAt,fingerprint,headlineKey(item.title),payload));
    }
    statements.push(env.DB.prepare(`INSERT INTO news_sources VALUES (?,?,?,'ok',?,?,?,?) ON CONFLICT(source) DO UPDATE SET attempted_at=excluded.attempted_at,success_at=excluded.success_at,status=excluded.status,detail=excluded.detail,limited=excluded.limited,accepted=excluded.accepted,rejected=excluded.rejected WHERE excluded.attempted_at>=news_sources.attempted_at`)
      .bind(source,requestAt,observedAt,result.limited?'取得できた配信分のみです。全件を網羅していません。':'指定した取得窓の応答を処理しました。',Number(result.limited),result.articles.length,result.rejected));
    await env.DB.batch(statements);return {ok:true,source,accepted:result.articles.length,limited:result.limited,rejected:result.rejected};
  }catch(error){
    const detail=error instanceof AppError?error.message:'ニュース処理に失敗しました。保存済みの記事は保持しています。';
    await env.DB.prepare(`INSERT INTO news_sources VALUES (?,?,NULL,'failed',?,1,0,0) ON CONFLICT(source) DO UPDATE SET attempted_at=excluded.attempted_at,status='failed',detail=excluded.detail WHERE excluded.attempted_at>=news_sources.attempted_at`).bind(source,requestAt,detail).run();
    throw new AppError(502,detail);
  }
}
type Row={id:string;source:NewsSource;url:string;title:string;published_at:string;updated_at:string|null;first_seen:string;last_seen:string;fingerprint:string;headline_key:string;evidence:string;revision_seen:string|null;symbols:string|null};
export async function readNews(env:Env,now=new Date()){
  const status=await env.DB.prepare('SELECT * FROM news_sources').all<{source:NewsSource;attempted_at:string;success_at:string|null;status:string;detail:string;limited:number;accepted:number;rejected:number}>();
  const sourceStates=NEWS_SOURCES.map(source=>{
    const row=status.results.find(r=>r.source===source);
    return {source,name:SOURCE_NAMES[source],state:!row?'unavailable':row.status==='failed'?'failed':!row.success_at||Date.parse(row.success_at)<now.getTime()-16*3600000?'stale':'current',lastAttempt:row?.attempted_at??null,lastSuccess:row?.success_at??null,detail:row?.detail??'未取得です。',limited:row?.limited===1,rejected:row?.rejected??0};
  });
  const rows=await env.DB.prepare('SELECT news_items.*,news_revisions.observed_at AS revision_seen,news_revisions.symbols AS symbols FROM news_items LEFT JOIN news_revisions ON news_revisions.id=news_items.id AND news_revisions.fingerprint=news_items.fingerprint WHERE news_items.published_at>=? ORDER BY news_items.published_at DESC,news_items.id LIMIT 80').bind(new Date(now.getTime()-30*86400000).toISOString()).all<Row>();
  const headlineCounts=new Map<string,number>();for(const r of rows.results){const key=r.published_at.slice(0,10)+'|'+r.headline_key;headlineCounts.set(key,(headlineCounts.get(key)??0)+1);}
  const seen=new Set<string>();let duplicates=0;
  const ranked=rows.results.filter(r=>{const key=r.url;if(seen.has(key)){duplicates++;return false;}seen.add(key);return true;}).map(r=>({priority:prioritizeNews({title:r.title,source:r.source,publishedAt:r.published_at,updatedAt:r.updated_at,symbols:JSON.parse(r.symbols??'[]')},now),id:r.id,source:r.source,title:r.title,url:r.url,publishedAt:r.published_at,updatedAt:r.updated_at,firstSeen:r.first_seen,lastSeen:r.last_seen,revisionSeen:r.revision_seen??r.first_seen,fingerprint:r.fingerprint,evidence:JSON.parse(r.evidence) as NewsEvidence,similarHeadlines:(headlineCounts.get(r.published_at.slice(0,10)+'|'+r.headline_key)??1)-1,sourceState:sourceStates.find(s=>s.source===r.source)!.state})).sort((a,b)=>Number(b.priority.recent)-Number(a.priority.recent)||Number(b.priority.concern)-Number(a.priority.concern)||b.priority.score-a.priority.score||b.publishedAt.localeCompare(a.publishedAt));
  const articles=ranked.slice(0,40),purchaseReview=summarizeNewsReview(ranked,sourceStates,now);
  return {version:NEWS_VERSION,priorityVersion:PRIORITY_VERSION,purchaseReview,checkedAt:now.toISOString(),sources:sourceStates,articles,duplicates,displayLimited:rows.results.length>=80||rows.results.length-duplicates>40,
    reviewCandidates:articles.filter(a=>a.evidence.reviewRequired&&Date.parse(a.updatedAt??a.publishedAt)>=now.getTime()-48*3600000).length,
    assessment:'購入候補の価格下落に懸念材料がないか確認するための情報です。悪材料・懸念材料を優先します。記事がないことは悪材料がない証拠ではなく、下落の原因も未判定です。'};
}
