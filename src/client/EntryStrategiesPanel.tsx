import type {EntryStrategies} from '../domain/entry-strategies';
import type {NewsReview} from '../domain/news-review';
const number=(n:number|null)=>n===null?'—':n.toFixed(2);
const state=(value:boolean|null)=>value===null?'履歴不足':value?'条件成立（検証中）':'条件待ち';
export default function EntryStrategiesPanel({strategies,reviews}:{strategies:EntryStrategies[];reviews:NewsReview[]|null}){
 return <><h3>2つの購入候補</h3><p>確定終値で判定します。良材料は裏付け候補で、利益や購入を保証しません。買い・売り通知は未有効です。</p>
 <div className="price-rule-cards">{strategies.map(s=>{
 const news=reviews?.find(r=>r.symbol===s.symbol),support=news?.support??[];
 return <article key={s.symbol} className="entry-strategy"><h3>{s.symbol}</h3><p>価格基準日：{s.asOf} · 終値 {number(s.close)} USD</p>
 <h4>20営業日高値更新</h4><strong className={`rule-state ${s.breakout.matched?'rule-matched':''}`}>{state(s.breakout.matched)}</strong>
 <p>直前20営業日の最高終値：{number(s.breakout.previousHigh)} USD<br/>最高終値から：{number(s.breakout.distancePct)}%</p>
 <h4>良材料による裏付け</h4><p>{!news||news.incomplete?'ニュース確認不足':support.length?(s.breakout.matched?'高値更新＋良材料の裏付け候補あり':'良材料候補あり（価格条件とは別判定）'):'取得見出しの範囲では良材料の裏付けを検出せず'}</p>
 {support.map(a=><p key={a.url}><a href={a.url} target="_blank" rel="noopener noreferrer">{a.title}</a><br/><small>{a.reason}</small></p>)}
 <p>{news?.count?`懸念材料も${news.count}件あります。良材料で相殺しません。`:news?.state==='not-detected'?'取得見出しの範囲では懸念材料を検出せず。':'反対材料の確認情報が不足しています。'}</p>
 {news?.reasons.map(a=><p key={a.url}><a href={a.url} target="_blank" rel="noopener noreferrer">{a.title}</a><br/><small>{a.reason}</small></p>)}
 <small>支持は直近24時間の見出しを分類。本文・真偽・新規性・織り込みは未確認です。良材料の有無を勝率へ換算しません。</small>
 {news&&<p><small>確認：{new Date(news.checkedAt).toLocaleString('ja-JP',{timeZone:'Asia/Tokyo'})} JST</small></p>}
 <h4>20日高値更新の出口方針</h4><p>損切りなしを維持。含み益での固定利確（+20% / +30%）と、利益を伸ばして反落時に売る方式を比較予定です。20営業日後は再評価の目安で、強制売却しません。</p><p>出口条件は検証中・未設定です。個別の利確価格や売却指示ではありません。未回復の保有も評価に含めます。</p>
 <h4>長期の安さ</h4><strong className={`rule-state ${s.longValue.matched?'rule-matched':''}`}>{state(s.longValue.matched)}</strong>
 <p>{s.longValue.rankPct===null?`必要な過去756営業日に対し${s.longValue.count}日。3年順位を代用せず保留します。`:`過去756営業日（約3年）で下位${number(s.longValue.rankPct)}%。下位10%以下が条件です。`}</p><p>3年の最安値更新とは別の指標です。安さの背景にある悪材料を上のニュース欄で確認してください。</p>
 {s.frequency&&<details><summary>20日高値更新の発生頻度</summary><p>{s.frequency.from}〜{s.frequency.through}の{s.frequency.days}営業日中、{s.frequency.updates}日（{number(s.frequency.ratePct)}%）で更新。連続する更新日をまとめると{s.frequency.episodes}回です。</p><p>一日でも更新しなければ次を別の回として数えます。独立した急騰や購入・通知回数ではありません。</p></details>}
 </article>})}</div></>;
}
