import {useEffect,useRef,useState} from 'react';
import type {PriceDecision} from '../domain/price-rules';
import './price-rules.css';
type Evaluation={version:string;rows:{symbol:string;period:string;through:string;rule:"baseline"|"pullback"|"recovery";completed:number;meanPct:number|null;medianPct:number|null;worstReturnPct:number|null}[]};
type Payload={evaluation:Evaluation|null;version:string;state:string;detail:string;decisions:PriceDecision[];observations:{marketDate:string;observedAt:string;inputHash:string;decisions:PriceDecision[]}[]};
type Props={api:<T>(path:string,method?:string,body?:unknown)=>Promise<T>;onAuthError:(e:unknown)=>void;dataKey:string};
const labels={insufficient:'履歴不足',pause:'価格条件では買い増し見送り',waiting:'条件待ち',matched:'価格条件に一致（検証中）'};
const names={pullback:'上昇傾向での押し目',recovery:'20日平均の上抜け確認'};
const n=(value:number)=>value.toFixed(2);
export default function PriceRulesPanel({api,onAuthError,dataKey}:Props) {
  const [data,setData]=useState<Payload|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState('');
  const service=useRef({api,onAuthError});service.current={api,onAuthError};
  const sequence=useRef(0),alive=useRef(false);
  async function load(observe=false) {
    const id=++sequence.current;setBusy(true);setError('');
    try {
      if(observe) await service.current.api('price-rules/observe','POST');
      const value=await service.current.api<Payload>('price-rules');
      if(alive.current&&id===sequence.current) setData(value);
    } catch(e) {
      if(alive.current&&id===sequence.current) {
        setData(null);setError(e instanceof Error?e.message:'条件判定を取得できません。');
        if(e&&typeof e==='object'&&'status' in e&&e.status===401) service.current.onAuthError(e);
      }
    } finally {if(alive.current&&id===sequence.current) setBusy(false);}
  }
  useEffect(()=>{alive.current=true;setData(null);void load();return()=>{alive.current=false;sequence.current++;};},[dataKey]);
  return <section className="panel price-rules-panel" aria-label="価格ルールの検証" aria-busy={busy}>
    <div className="section-heading"><h2>価格ルールの検証</h2><button disabled={busy} onClick={()=>void load()}>条件を更新</button></div>
    <p>2つの価格仮説を観測しています。購入額はご自身で決めてください。ニュース・予算を含む買い時判定と自動通知は、まだ有効にしていません。</p>
    <p role="status">{busy?'読み込み中…':data?.detail}</p>{error&&<p role="alert">{error}</p>}
    {data?.state==='available'&&<div className="price-rule-cards">{data.decisions.map(d=><article key={d.symbol}>
      <h3>{d.symbol}</h3><span className={`rule-state rule-${d.state}`}>{labels[d.state]}</span>
      <p>価格基準日：{d.asOf}（米国取引日）</p>
      {d.matched.map(rule=><p key={rule}>{names[rule]}</p>)}
      {d.values?<><ul>{d.checks.map(c=><li key={c.label}>{c.passed?'✓':'—'} {c.label}</li>)}</ul>
        <dl><div><dt>終値 / 20日平均</dt><dd>{n(d.values.close)} / {n(d.values.sma20)} USD</dd></div>
        <div><dt>50日 / 200日平均</dt><dd>{n(d.values.sma50)} / {n(d.values.sma200)} USD</dd></div>
        <div><dt>RSI14</dt><dd>{n(d.values.rsi14)}</dd></div></dl></>:<p>205営業日分の確定終値が必要です。</p>}
    </article>)}</div>}
    {data?.evaluation&&<details open><summary>過去検証：20営業日後の値動き</summary>
      <p>2019〜2023年を前期、2024年以降を後期として比較。検証終点：{data.evaluation.rows.find(r=>r.period==='後期')?.through ?? '—'}。条件が出た翌営業日の終値から測定し、仮の往復コスト0.5%を差し引いています。</p>
      <p>表は横にスワイプすると、平均・中央値・最悪の変化を確認できます。</p>
      <div className="rule-table-scroll" role="region" aria-label="過去検証の表（横スクロール）" tabIndex={0}><table><caption>開始日は群によって異なります。運用成績や将来の上昇確率ではありません。</caption><thead><tr><th>銘柄・期間</th><th>条件</th><th>完了数</th><th>平均</th><th>中央値</th><th>最悪の終点変化</th></tr></thead><tbody>{data.evaluation.rows.map(r=><tr key={`${r.symbol}-${r.period}-${r.rule}`}><th>{r.symbol}・{r.period}</th><td>{r.rule==='baseline'?'条件なし':names[r.rule]}</td><td>{r.completed}</td>{[r.meanPct,r.medianPct,r.worstReturnPct].map((v,i)=><td key={i}>{v===null?'—':n(v)+'%'}</td>)}</tr>)}</tbody></table></div>
      <p>条件一致の件数は少なく、期間によって結果も変わっています。損切りなしの資金拘束、配当、ニュースは評価していません。売買ルールとしての有効性は未確認です。</p>
    </details>}
    <details><summary>一致条件と観測方法</summary>
      <p>共通条件：終値と50日平均が200日平均より上、50日平均が5営業日前より上、RSI14が70以下。</p>
      <p>押し目：共通条件に加え、昨日・今日とも20日平均未満、今日は前日比上昇、RSI14が40〜60。</p>
      <p>回復確認：共通条件に加え、前日は20日平均以下、今日は20日平均超、RSI14が45〜65。</p>
      <p>閾値は検証用の仮説です。RSIの計算には毎回直近205営業日を使います。見送りは価格条件の不一致を意味し、売却の指示ではありません。</p>
      <p>毎日9・15・21時20分頃（JST）に最新の価格が揃っていれば観測します。同じ取引日の最初の観測を保持し、後から書き換えません。保存期間は1年、画面は直近30取引日です。</p>
    </details>
    <button disabled={busy||data?.state!=='available'||data.decisions.some(d=>d.state==='insufficient')} onClick={()=>void load(true)}>現在の条件を観測に保存</button>
    {data&&<><h3>今後の検証用に保存した観測</h3>{!data.observations.length?<p>観測はまだありません。過去検証の結果とは別に記録します。</p>:<ol className="rule-history">{data.observations.map(o=><li key={o.marketDate}><strong>{o.marketDate}</strong><span>{o.decisions.map(d=>`${d.symbol}：${labels[d.state]}`).join(' / ')}</span><small>初回観測：{new Date(o.observedAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})} JST</small></li>)}</ol>}
      <small>ルール版：{data.version} · ニュース未評価 · 購入額の自動計算なし</small></>}
  </section>;
}
