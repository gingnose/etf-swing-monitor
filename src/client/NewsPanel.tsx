import type {NewsReview} from '../domain/news-review';
import type {Priority} from '../domain/news-priority';
import {useEffect,useRef,useState} from 'react';
import {NEWS_SOURCES,SOURCE_NAMES,type NewsSource,type NewsEvidence} from '../domain/news';
import './news.css';
type SourceState={source:NewsSource;name:string;state:string;lastAttempt:string|null;lastSuccess:string|null;detail:string;limited:boolean;rejected:number};
type Article={priority:Priority;id:string;source:NewsSource;title:string;url:string;publishedAt:string;updatedAt:string|null;firstSeen:string;lastSeen:string;revisionSeen:string;evidence:NewsEvidence;sourceState:string;similarHeadlines:number};
type Payload={checkedAt:string;purchaseReview:NewsReview[];priorityVersion:string;version:string;sources:SourceState[];articles:Article[];duplicates:number;displayLimited:boolean;reviewCandidates:number;assessment:string};
type Props={api:<T>(path:string,method?:string,body?:unknown)=>Promise<T>;onAuthError:(e:unknown)=>void;refreshKey:number;onReview:(value:NewsReview[]|null)=>void};
const stateNames:Record<string,string>={current:'取得成功',unavailable:'未取得',failed:'取得失敗',stale:'取得が古い'};
const time=(s:string|null)=>s?new Date(s).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}):'—';
export default function NewsPanel({api,onAuthError,onReview,refreshKey}:Props){
 const [data,setData]=useState<Payload|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[progress,setProgress]=useState(''),[filter,setFilter]=useState('all'),[expanded,setExpanded]=useState(false);
 const services=useRef({api,onAuthError,onReview});services.current={api,onAuthError,onReview};const alive=useRef(false),locked=useRef(false);
 function auth(e:unknown){if(e&&typeof e==='object'&&'status'in e&&e.status===401){setData(null);services.current.onAuthError(e);return true;}return false;}
 async function load(refresh=false){
  if(locked.current)return;locked.current=true;services.current.onReview(null);setBusy(true);setError('');setProgress('');
  const failures:string[]=[];
  try{
   if(refresh)for(const source of NEWS_SOURCES){
    if(!alive.current)return;setProgress(`${SOURCE_NAMES[source]}を確認中…`);
    try{await services.current.api('news/refresh','POST',{source});}catch(e){if(!alive.current||auth(e))return;failures.push(SOURCE_NAMES[source]+': '+(e instanceof Error?e.message:'取得できませんでした。'));}
   }
   const result=await services.current.api<Payload>('news');if(alive.current){setData(result);services.current.onReview(result.purchaseReview);setError(failures.join(' / '));}
  }catch(e){if(alive.current&&!auth(e)){setData(null);setError(e instanceof Error?e.message:'ニュースを読み込めませんでした。');}}
  finally{locked.current=false;if(alive.current){setBusy(false);setProgress('');}}
 }
 useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false;services.current.onReview(null);};},[refreshKey]);
 const matching=data?.articles.filter(a=>filter==='all'||a.evidence.targets.includes(filter))??[];
 const focused=matching.filter(a=>a.priority.level!=='normal'&&Date.parse(a.publishedAt)>=Date.parse(data?.checkedAt??'')-7*86400000).slice(0,5);
 const articles=expanded?matching:focused;
 return <section id="news" className="panel news-panel" aria-label="ニュースと出所" aria-busy={busy}>
  <div className="section-heading"><h2>購入前のニュース確認</h2><button disabled={busy} onClick={()=>void load(true)}>ニュースを取得</button></div>
  <p>価格条件を見て購入を考える際に、慎重に判断すべき材料がないか確認します。ニュースだけで購入を勧めるものではありません。</p>
  <p role="status">{busy?(progress||'読み込み中…'):data?.assessment}</p>{error&&<p role="alert" className="news-error">{error}</p>}
  {data&&<>
   <details className="news-source-details"><summary>情報源の取得状況（3件）</summary><div className="news-sources">{data.sources.map(s=><div key={s.source}><strong>{s.name}</strong><span className={s.state==='current'?'news-ok':'news-warning'}>{stateNames[s.state]}</span><small>最終成功 {time(s.lastSuccess)} JST / 試行 {time(s.lastAttempt)} JST</small><small>{s.detail}{s.rejected>0?` 出所・日時などで未採用：${s.rejected}件。`:''}</small></div>)}</div></details>
   <p className="news-focus">悪材料・懸念材料を優先して、直近7日の重要な記事を最大5件表示します。方向や重要度は見出しによる推定です。</p>
   <label className="news-filter">関連候補を絞る <select value={filter} onChange={e=>setFilter(e.target.value)} aria-label="ニュースの関連銘柄"><option value="all">すべて</option><option value="SOXL">SOXL</option><option value="TQQQ">TQQQ</option></select></label>
   {!articles.length&&<p>現在、表示範囲に優先して確認する記事はありません。悪材料がないことを保証しません。</p>}
   <ol className="news-articles">{articles.map(a=><li key={a.id}>
    <div className="news-labels"><span className={a.priority.concern?'news-concern':''}>{a.priority.concern?'買い増し前に確認':a.priority.level==='critical'?'特に重要':a.priority.level==='important'?'重要':'参考'}</span><span>{{positive:'好材料候補',negative:'悪材料候補',mixed:'良悪混在',unknown:'方向未判定'}[a.priority.direction]}</span><span>{a.evidence.sourceKind==='official'?'公式の発信':'報道'}</span><span>{a.evidence.targets.join(' / ')}</span>{a.evidence.reviewRequired&&<span>内容確認候補</span>}</div>
    <h3><a href={a.url} target="_blank" rel="noopener noreferrer">{a.title}<span aria-hidden="true"> ↗</span></a></h3>
    <small>{SOURCE_NAMES[a.source]} · 公開 {time(a.publishedAt)} JST · 出所確認／内容未照合{a.sourceState!=='current'?' · この提供元の最新取得を確認できていません':''}</small>
    <p className="news-topic">優先した理由：{a.priority.reason}</p>
    <details><summary>関連の根拠・取得時刻</summary><ul>{a.evidence.reasons.map(reason=><li key={reason}>{reason}</li>)}</ul>
     <p>公開：{time(a.publishedAt)} JST<br/>配信元の更新：{time(a.updatedAt)} JST<br/>記事の初回取得：{time(a.firstSeen)} JST<br/>この版の初回取得：{time(a.revisionSeen)} JST<br/>最終取得：{time(a.lastSeen)} JST</p>
     <p>{a.priority.uncertainty} 下落の原因を特定したものではありません。{a.evidence.sourceKind==='official'?'公式発信にも発信者の見解・将来予測を含む場合があります。':''}{a.similarHeadlines?` 同日・同じ見出しの候補がほかに${a.similarHeadlines}件あります。独立した裏付けとは数えません。`:''}</p>
    </details>
   </li>)}</ol>
   {matching.length>focused.length&&<button onClick={()=>setExpanded(v=>!v)}>{expanded?'重要な記事だけに戻す':`参考記事も含めて表示（${matching.length}件）`}</button>}
   <p className="news-footnote">{data.displayLimited?'表示は直近の記事の一部です。 ':''}RSSの先頭5件とAlpacaの直近7日・最新10件に限るため、全ニュースを網羅しません。政府の輸出規制発表、物価統計、全構成銘柄の直接取得は未対応です。</p>
   <details><summary>自動取得・分析の範囲</summary><p>毎時25分にBenzinga、30分にFRB、35分にNVIDIAを取得します（JST）。Alpacaは直近20分を除外。提供元ごとに処理し、一部が失敗しても他の情報源は保持します。</p><p>重要度は見出し・タグ・発信者のルールで分類します。特に重要な悪材料・懸念材料だけを毎時評価し、自動通知は合計1日1回まで。良材料は画面表示のみです。同種の材料は72時間重複を抑制します。予想・噂・否定表現は通知しません。本文のAI分析や真偽の自動確認は未対応です。ニュースが見つからなくても、価格の割安さや購入の安全性を保証しません。</p></details>
   <small>分類ルール：{data.priorityVersion}</small>
  </>}
 </section>;
}
