import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';import {resolve} from 'node:path';import {createHash} from 'node:crypto';
import {CALIBRATION_VERSION,START,features,RULES,study,quantile,summarize} from '../src/domain/price-calibration.ts';
import {validateCloses} from '../src/domain/price-rules.ts';
const root=resolve(import.meta.dirname,'..'),dir=resolve(root,'private');mkdirSync(dir,{recursive:true,mode:0o700});
const raw=readFileSync(resolve(dir,'price-study-data.json'),'utf8'),dataset=JSON.parse(raw);
if(dataset.feed!=='sip'||dataset.adjustment!=='split'||!dataset.symbols?.SOXL||!dataset.symbols?.TQQQ)throw Error('Expected SIP split-adjusted history');
const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
if(dataset.through>=today||dataset.through!==dataset.symbols.SOXL.at(-1)?.date||dataset.through!==dataset.symbols.TQQQ.at(-1)?.date)throw Error('Unfinished or mismatched history');
if(JSON.stringify(dataset.symbols.SOXL.map(x=>x.date))!==JSON.stringify(dataset.symbols.TQQQ.map(x=>x.date)))throw Error('Dates differ across symbols');
const report={version:CALIBRATION_VERSION,createdAt:new Date().toISOString(),inputHash:createHash('sha256').update(raw).digest('hex'),fetchedAt:dataset.fetchedAt,start:dataset.start,through:dataset.through,rules:RULES,distributions:[],results:[],yearly:[],regimes:[]};
for(const [symbol,rows]of Object.entries(dataset.symbols)){
 validateCloses(rows);if(rows.length<1000)throw Error('Insufficient observations');const f=features(rows);
 for(const [period,from,through]of [['前期','2019-01-01','2023-12-31'],['後期','2024-01-01',dataset.through]]){
  const subset=f.slice(START).filter(x=>x.date>=from&&x.date<=through);
  for(const regime of ['all','uptrend','other']){
   const selected=subset.filter(x=>regime==='all'||(regime==='uptrend'?x.trend:!x.trend));
   for(const metric of ['z','logZ','robustZ','rank']){
    const v=selected.map(x=>x[metric]).filter(x=>x!==null&&Number.isFinite(x));
    const pct=limit=>v.length?100*v.filter(x=>x<=limit).length/v.length:null;
    report.distributions.push({symbol,period,regime,metric,n:v.length,from:selected[0]?.date??null,through:selected.at(-1)?.date??null,q01:quantile(v,.01),q05:quantile(v,.05),q10:quantile(v,.1),q50:quantile(v,.5),q90:quantile(v,.9),q95:quantile(v,.95),q99:quantile(v,.99),lower15:pct(-1.5),lower2:pct(-2),lower25:pct(-2.5),lower3:pct(-3),upper2:v.length?100*v.filter(x=>x>=2).length/v.length:null});
   }
  }
  for(const horizon of [10,20])for(const costPct of [0,.5,1])for(const rule of [null,'trend-control',...RULES]){
   const result=study(rows,f,from,through,horizon,typeof rule==='object'?rule:null,costPct,rule==='trend-control');
   report.results.push({symbol,period,from,through,horizon,costPct,id:rule===null?'baseline':rule==='trend-control'?rule:rule.id,...result});
   if(horizon===20&&costPct===.5){
    for(const high of [false,true])report.regimes.push({symbol,period,id:rule===null?'baseline':rule==='trend-control'?rule:rule.id,volatility:high?'high':'low',...summarize(result.events.filter(e=>e.volHigh===high))});
   }
  }
 }
 for(let year=2020;year<=Number(dataset.through.slice(0,4));year++)for(const rule of [null,...RULES.filter(r=>r.family==='core')]){
  const through=Math.min(year,Number(dataset.through.slice(0,4)))===Number(dataset.through.slice(0,4))?dataset.through:`${year}-12-31`;
  const result=study(rows,f,`${year}-01-01`,through,20,rule,.5);report.yearly.push({symbol,year,id:rule?.id??'baseline',...result});
 }
}
writeFileSync(resolve(dir,'price-calibration-report.json'),JSON.stringify(report,null,2),{mode:0o600});
const pct=x=>x===null?'—':x.toFixed(2)+'%',num=x=>x===null?'—':x.toFixed(2);
const lines=['# SOXL / TQQQ 乖離指標の比較（探索分析）','',`データ：${dataset.start}〜${dataset.through}、SIP・分割調整、各銘柄${dataset.symbols.SOXL.length}営業日。指標の共通ウォームアップ後から評価。`,
 '','## σの実測分布','', '| 銘柄 | 期間 | 日数 | z≤−2 | z≤−2.5 | z≤−3 | z≥+2 | 下位5%のz | 上位5%のz |','|---|---|---:|---:|---:|---:|---:|---:|---:|'];
for(const r of report.distributions.filter(r=>r.metric==='z'&&r.regime==='all'))lines.push(`| ${r.symbol} | ${r.period} | ${r.n} | ${pct(r.lower2)} | ${pct(r.lower25)} | ${pct(r.lower3)} | ${pct(r.upper2)} | ${num(r.q05)} | ${num(r.q95)} |`);
lines.push('','## 主要候補：20営業日後（仮コスト0.5%控除）','','条件翌営業日の終値から測定。同一群の重複期間を除外。平均差は戦略の超過収益ではありません。','', '| 銘柄 | 期間 | 条件 | 完了数 | 平均 | 中央値 | 最悪の期間内下落 |','|---|---|---|---:|---:|---:|---:|');
for(const r of report.results.filter(r=>r.horizon===20&&r.costPct===.5&&(RULES.find(s=>s.id===r.id)?.family==='core'||['baseline','trend-control'].includes(r.id))))lines.push(`| ${r.symbol} | ${r.period} | ${RULES.find(s=>s.id===r.id)?.label??r.id} | ${r.completed} | ${pct(r.meanPct)} | ${pct(r.medianPct)} | ${pct(r.worstPathPct)} |`);
for(const family of ['sensitivity','exit-diagnostic']){
 lines.push('',`## ${family==='sensitivity'?'閾値への感度（最良値を選ばない）':'上側到達後の変化（売却の妥当性を保証しない）'}`,'','| 銘柄 | 期間 | 条件 | 完了数 | 平均 | 中央値 | 最悪の期間内下落 |','|---|---|---|---:|---:|---:|---:|');
 for(const r of report.results.filter(r=>r.horizon===20&&r.costPct===.5&&RULES.find(s=>s.id===r.id)?.family===family))lines.push(`| ${r.symbol} | ${r.period} | ${RULES.find(s=>s.id===r.id).label} | ${r.completed} | ${pct(r.meanPct)} | ${pct(r.medianPct)} | ${pct(r.worstPathPct)} |`);
}
lines.push('','## 年別の安定性：20営業日・コスト0.5%','', '| 銘柄 | 年 | 条件 | 完了数 | 平均 | 中央値 |','|---|---|---|---:|---:|---:|');
for(const r of report.yearly)lines.push(`| ${r.symbol} | ${r.year} | ${r.id} | ${r.completed} | ${pct(r.meanPct)} | ${pct(r.medianPct)} |`);
lines.push('','## 留意点','','事後に指定した既知データでの探索で、期間分割を未見データとは呼びません。候補・閾値を複数比較しており、最良の結果は過大評価され得ます。少数イベントの平均・中央値を上昇確率に変換しません。価格下落は終値ベース。未決済の買い増し・損切りなしの運用、資金拘束、配当、税、為替、現実の売買コスト・約定は再現していません。ニュースは含めません。', '', 'SOXLの基準指数は2021年に変更されています。前後を同じ不変なモデルと解釈しません。中央値/MADは急変値の影響を抑えますが、急変を無視してよい意味ではありません。順位は当日を含まない過去252個の乖離から計算し、低順位だけで反発を予測しません。', '', `入力SHA256: ${report.inputHash}`);
writeFileSync(resolve(dir,'price-calibration-report.md'),lines.join('\n')+'\n',{mode:0o600});
console.log(JSON.stringify({version:report.version,through:report.through,results:report.results.length,report:'private/price-calibration-report.md'}));
