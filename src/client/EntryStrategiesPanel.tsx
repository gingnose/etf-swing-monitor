import type {EntryStrategies} from '../domain/entry-strategies';
import type {NewsReview} from '../domain/news-review';
const number=(n:number|null)=>n===null?'—':n.toFixed(2);
const state=(v:boolean|null)=>v===null?'履歴不足':v?'条件成立':'条件待ち';
export default function EntryStrategiesPanel({strategies,reviews}:{strategies:EntryStrategies[];reviews:NewsReview[]|null}){
 return <div className="price-rule-cards">{strategies.map(s=>{
 const news=reviews?.find(r=>r.symbol===s.symbol),support=news?.support??[];
 return <article key={s.symbol} className="entry-strategy">
 <div className="entry-heading"><h3>{s.symbol}</h3><span>{s.asOf} 終値</span></div>
 <div className="entry-price">{number(s.close)} <span>USD</span></div>
 <div className="signal-row"><div><h4>20日高値</h4><small>基準 ${number(s.breakout.previousHigh)} · {number(s.breakout.distancePct)}%</small></div><strong className={`rule-state ${s.breakout.matched?'rule-matched':''}`}>{state(s.breakout.matched)}</strong></div>
 <div className="signal-row"><div><h4>長期の安さ</h4><small>{s.longValue.rankPct===null?'3年分の履歴が不足':`3年で下位 ${number(s.longValue.rankPct)}% · 目安10%以下`}</small></div><strong className={`rule-state ${s.longValue.matched?'rule-matched':''}`}>{state(s.longValue.matched)}</strong></div>
 <div className="entry-news" aria-label="ニュースの要点"><span>良材料 <b>{!news||news.incomplete?'未確認':support.length?`${support.length}件`:'未検出'}</b></span><span className={news?.count?'has-concern':''}>懸念 <b>{news?.count?`${news.count}件`:!news||news.state==='insufficient'?'未確認':'未検出'}</b></span></div>
 {news?.incomplete&&<p className="compact-warning">ニュースの取得が不完全です</p>}
 <div className="exit-summary"><span>出口</span><span>損切りなし · 利確条件は未設定</span></div>
 <details className="entry-details"><summary>根拠・出口・頻度を見る</summary>
 <h4>ニュースの根拠</h4>
 {support.map(a=><p key={a.url}><span className="evidence-label">良材料</span> <a href={a.url} target="_blank" rel="noopener noreferrer">{a.title} ↗</a><br/><small>{a.reason}</small></p>)}
 {news?.reasons.map(a=><p key={a.url}><span className="evidence-label concern">懸念</span> <a href={a.url} target="_blank" rel="noopener noreferrer">{a.title} ↗</a><br/><small>{a.reason}</small></p>)}
 <p>取得した見出しによる分類です。未検出は材料がない証明ではありません。本文・真偽・織り込みは未確認。良材料で懸念を相殺しません。</p>
 {news&&<small>確認：{new Date(news.checkedAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})} JST</small>}
 <h4>20日高値更新の出口方針</h4><p>損切りなしを維持。固定利確（+20% / +30%）と利益を伸ばして反落時に売る方式を比較予定です。20営業日後は再評価の目安。強制売却しません。</p><p>出口条件は未設定で、売却指示ではありません。</p>
 <h4>判定方法</h4><p>20日高値は当日を除く直前20営業日の最高終値を上回ること。長期の安さは過去756営業日の価格順位が下位10%以下で、3年安値更新とは異なります。</p>
 {s.longValue.rankPct===null&&<p>過去{s.longValue.count}日 / 必要756日。3年順位を代用せず保留します。</p>}
 {s.frequency&&<><h4>20日高値更新の発生頻度</h4><p>{s.frequency.from}〜{s.frequency.through}の{s.frequency.days}営業日中、{s.frequency.updates}日（{number(s.frequency.ratePct)}%）で更新。連続する更新日をまとめると{s.frequency.episodes}回です。</p><p>独立した急騰や購入・通知回数ではありません。</p></>}
 </details></article>})}</div>;
}
