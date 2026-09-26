import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {resolve} from 'node:path';import {createHash} from 'node:crypto';
import {POSITION_VERSION,LOOKBACKS,HORIZONS,COMMON_START,pricePositions,positionEvents,positionSummary,targetSummary} from '../src/domain/price-position.ts';
import {validateCloses} from '../src/domain/price-rules.ts';
const dir=resolve(import.meta.dirname,'../private');mkdirSync(dir,{recursive:true,mode:0o700});
const raw=readFileSync(resolve(dir,'price-study-data.json'),'utf8'),data=JSON.parse(raw);
if(data.feed!=='sip'||data.adjustment!=='split'||!data.symbols?.SOXL||!data.symbols?.TQQQ)throw Error('Expected SIP split-adjusted history');
const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
if(data.through>=today||['SOXL','TQQQ'].some(s=>data.symbols[s].at(-1)?.date!==data.through))throw Error('Unfinished or mismatched history');
if(JSON.stringify(data.symbols.SOXL.map(x=>x.date))!==JSON.stringify(data.symbols.TQQQ.map(x=>x.date)))throw Error('Mismatched calendars');
const report={version:POSITION_VERSION,inputHash:createHash('sha256').update(raw).digest('hex'),createdAt:new Date().toISOString(),through:data.through,fetchedAt:data.fetchedAt,lookbacks:LOOKBACKS,horizons:HORIZONS,commonStart:null,current:[],results:[]};
for(const symbol of ['SOXL','TQQQ']){
 const rows=data.symbols[symbol];validateCloses(rows);if(rows.length<=COMMON_START+252)throw Error('Insufficient history');report.commonStart=rows[COMMON_START].date;
 const conditions=[{id:'baseline',lookback:null,qualifies:rows.map(()=>true)}];
 for(const lookback of LOOKBACKS){
  const positions=pricePositions(rows,lookback);report.current.push({symbol,lookback,date:rows.at(-1).date,...positions.at(-1)});
  for(const rule of ['bottom10','newLow'])conditions.push({id:`${lookback}-${rule}`,lookback,qualifies:positions.map(p=>p!==null&&(rule==='newLow'?p.newLow:p.rank<=.1))});
 }
 for(const c of conditions)for(const cooldown of [20,252])for(const costPct of [0,.5,1]){
  const events=positionEvents(rows,c.qualifies,COMMON_START,cooldown,costPct);
  const summarize=es=>({target:targetSummary(es),common:HORIZONS.map(horizon=>({horizon,...positionSummary(es,horizon,true)})),available:HORIZONS.map(horizon=>({horizon,...positionSummary(es,horizon,false)}))});
  report.results.push({symbol,id:c.id,lookback:c.lookback,cooldown,costPct,signalDays:c.qualifies.slice(COMMON_START).filter(Boolean).length,anchors:events.length,...summarize(events),
    years:[...new Set(events.map(e=>e.signalDate.slice(0,4)))].map(year=>({year,...summarize(events.filter(e=>e.signalDate.startsWith(year)))})),events});
 }
}
writeFileSync(resolve(dir,'price-position-report.json'),JSON.stringify(report,null,2),{mode:0o600});
const p=v=>v===null?'—':v.toFixed(1)+'%',n=v=>v===null?'—':v.toFixed(1);
const lines=['# 時間軸別の価格の安さ：探索結果','',`入力: ${data.start}〜${data.through}。共通評価開始: ${report.commonStart}。過去756営業日を確保。`,
 '','安さ＝過去終値の順位。企業価値の割安評価ではない。下表は全て252営業日を観察済みの同じ事例群。次の終値で仮購入、仮往復コスト0.5ポイント控除。営業日単位。20日間シグナルを間引いているが長期の観察期間は重なる。事例数は独立試行数ではない。',''];
for(const symbol of ['SOXL','TQQQ']){
 lines.push(`## ${symbol}`,'','| 条件 | 完了数 | 5日中央値 | 20日中央値 | 63日中央値 | 126日中央値 | 252日中央値 | 252日期間内最悪 | +10%到達数 | 到達例の日数中央値 |','|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
 for(const r of report.results.filter(r=>r.symbol===symbol&&r.cooldown===20&&r.costPct===.5))lines.push(`| ${r.id} | ${r.target.completed} | ${r.common.map(s=>p(s.medianPct)).join(' | ')} | ${p(r.common.at(-1).worstPathPct)} | ${r.target.hit}/${r.target.completed} | ${n(r.target.medianDaysAmongHits)} |`);
}
lines.push('','## 長期観察の重複を抑えた補足（252営業日間引き）','','事例数が少なくなるため、この表も独立した有効性の証明ではない。主表と異なる開始日集合になる。','','| 銘柄 | 条件 | 完了数 | 20日中央値 | 63日中央値 | 252日中央値 |','|---|---|---:|---:|---:|---:|');
for(const r of report.results.filter(r=>r.cooldown===252&&r.costPct===.5))lines.push(`| ${r.symbol} | ${r.id} | ${r.target.completed} | ${[20,63,252].map(h=>p(r.common.find(s=>s.horizon===h).medianPct)).join(' | ')} |`);
lines.push('','## 3年の下位10%：採用日と観察状況','','| 銘柄 | 条件日 | 観察日数 | +10%到達日数 |','|---|---|---:|---:|');
for(const r of report.results.filter(r=>r.cooldown===20&&r.costPct===.5&&r.id==='756-bottom10'))for(const e of r.events)lines.push(`| ${r.symbol} | ${e.signalDate} | ${e.followed} | ${e.hitDay??'未到達'} |`);
lines.push('','## 最新の位置（助言ではない）','','| 銘柄 | 過去営業日数 | 価格順位 | 安値更新 | 過去最安から |','|---|---:|---:|---|---:|');
for(const r of report.current)lines.push(`| ${r.symbol} | ${r.lookback} | ${p(r.rank*100)} | ${r.newLow?'はい':'いいえ'} | ${p(r.distanceFromLowPct)} |`);
lines.push('','## 解釈の制約','','+10%の到達日数は到達した事例のみの中央値。未到達や追跡中を成功扱いしていない。252日未満の最近の事例は主表には入らない。全事例・年別・追跡中・252日間引き・コスト感度・各期間までの観察完了群はJSONに保存。最悪下落は購入終値基準で、途中の高値からのドローダウンではない。利確後の下落も固定期間には含む。','',
 '同じ危機の安値が複数回入る。既知データを使った探索であり、過去最良の時間軸を自動採用しない。SOXLの基準指数変更、分配未調整、未再現のニュース・資金配分・買い増し・為替・税の影響がある。長期の上昇や回復を前提にしない。', '',`入力SHA256: ${report.inputHash}`);
writeFileSync(resolve(dir,'price-position-report.md'),lines.join('\n')+'\n',{mode:0o600});
console.log(JSON.stringify({version:report.version,from:report.commonStart,through:report.through,groups:report.results.length,report:'private/price-position-report.md'}));
