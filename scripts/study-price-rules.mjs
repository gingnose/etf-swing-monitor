import {readFileSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {readPrivateConfig} from './private-config.mjs';
import {PRICE_RULE_VERSION,eventStudy,validateCloses} from '../src/domain/price-rules.ts';
const root=resolve(import.meta.dirname,'..'),dir=resolve(root,'private');
const start='2019-01-01';
const now=new Date();
const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
const datasetFile=resolve(dir,'price-study-data.json');
try {
  mkdirSync(dir,{recursive:true,mode:0o700});
  let dataset;
  if(process.argv.includes('--reuse')&&existsSync(datasetFile)) dataset=JSON.parse(readFileSync(datasetFile,'utf8'));
  else {
    const config=readPrivateConfig(root);
    if(!config.ALPACA_API_KEY||!config.ALPACA_API_SECRET) throw new Error('Alpacaキーが未設定です。');
    const headers={'APCA-API-KEY-ID':config.ALPACA_API_KEY,'APCA-API-SECRET-KEY':config.ALPACA_API_SECRET};
    async function get(url) {
      let response;
      try { response=await fetch(url,{headers,redirect:'manual',signal:AbortSignal.timeout(20000)}); }
      catch { throw new Error('価格検証用データへ接続できません。'); }
      if(!response.ok) throw new Error(`データ取得を停止しました（${new URL(url).pathname} / HTTP ${response.status}）。取得元や有料プランへは切り替えません。`);
      try {return await response.json();} catch {throw new Error('データ形式を確認できません。');}
    }
    const calendar=await get(`https://paper-api.alpaca.markets/v2/calendar?start=${start}&end=${today}`);
    if(!Array.isArray(calendar)) throw new Error('取引日カレンダーが不正です。');
    const dates=calendar.map(r=>r.date).filter(d=>d<today);
    if(dates.length<1000||Date.parse(dates[0])-Date.parse(start)>7*86400_000||Date.parse(today)-Date.parse(dates.at(-1))>7*86400_000||dates[0]<start||dates.at(-1)>=today||new Set(dates).size!==dates.length||dates.some((d,i)=>!/^\d{4}-\d{2}-\d{2}$/.test(d)||(i&&d<=dates[i-1]))) throw new Error('取引日カレンダーが不足・不正です。');
    const symbols={};
    for(const symbol of ['SOXL','TQQQ']) {
      let page,rows=[];const tokens=new Set();
      for(let n=0;n<10;n++) {
        const query=new URLSearchParams({symbols:symbol,timeframe:'1Day',start:start+'T00:00:00Z',end:new Date(Date.parse(today+'T00:00:00Z')-1).toISOString(),adjustment:'split',feed:'sip',sort:'asc',limit:'10000'});
        if(page) query.set('page_token',page);
        const data=await get('https://data.alpaca.markets/v2/stocks/bars?'+query);
        if(!Array.isArray(data.bars?.[symbol])) throw new Error('価格が欠損しています。');
        for(const b of data.bars[symbol]) {
          if(typeof b.t!=='string'||!/^\d{4}-\d{2}-\d{2}T0[45]:00:00(?:\.000)?Z$/.test(b.t)) throw new Error('日足時刻が不正です。');
          if(b.t.slice(0,10)<today) rows.push({date:b.t.slice(0,10),close:b.c});
        }
        page=data.next_page_token;
        if(!page) break;
        if(typeof page!=='string'||tokens.has(page)||n===9) throw new Error('価格のページ分割が完了しません。');
        tokens.add(page);
      }
      validateCloses(rows);
      if(JSON.stringify(rows.map(r=>r.date))!==JSON.stringify(dates)) throw new Error('価格と取引日カレンダーが一致しません。');
      symbols[symbol]=rows;
    }
    dataset={fetchedAt:now.toISOString(),start,through:dates.at(-1),feed:'sip',adjustment:'split',symbols};
    writeFileSync(datasetFile,JSON.stringify(dataset),{mode:0o600});
  }
  if(dataset.feed!=='sip'||dataset.adjustment!=='split'||dataset.start!==start||!dataset.symbols?.SOXL||!dataset.symbols?.TQQQ) throw new Error('検証データの形式が一致しません。');
  if(dataset.through!==dataset.symbols.SOXL.at(-1)?.date||dataset.through>=today||Date.parse(dataset.symbols.SOXL[0]?.date)-Date.parse(start)>7*86400_000) throw new Error('保存データの期間が不正です。');
  if(JSON.stringify(dataset.symbols.SOXL.map(r=>r.date))!==JSON.stringify(dataset.symbols.TQQQ.map(r=>r.date))) throw new Error('両銘柄の取引日が一致しません。');
  const results=[];
  for(const symbol of ['SOXL','TQQQ']) for(const [period,from,through] of [['前期','2019-01-01','2023-12-31'],['後期','2024-01-01',dataset.through]])
    for(const horizon of [10,20]) for(const costPct of [0,0.5,1]) for(const rule of ['baseline','pullback','recovery']) {
      results.push({symbol,period,from,through,horizon,costPct,rule,...eventStudy(symbol,dataset.symbols[symbol],from,through,horizon,rule,costPct)});
    }
  const report={version:PRICE_RULE_VERSION,createdAt:now.toISOString(),fetchedAt:dataset.fetchedAt,inputHash:createHash('sha256').update(JSON.stringify(dataset)).digest('hex'),results};
  writeFileSync(resolve(dir,'price-study-report.json'),JSON.stringify(report,null,2),{mode:0o600});
  const pct=n=>n===null?'—':n.toFixed(2)+'%';
  const lines=['# 価格条件の過去検証', '', `ルール: ${PRICE_RULE_VERSION} / データ: ${dataset.start}〜${dataset.through} / SIP・分割調整`, '',
    'これは購入後の値動きを調べるイベント分析です。売却ルールや運用成績を検証したものではありません。条件確定の翌営業日終値を仮の開始価格とし、20営業日後を比較します。同じ群の観測期間は重複させません。期間境界をまたぐ観測は未完了扱いです。', '',
    '以下は仮の往復コスト0.5%を差し引いた結果。実際の証券会社の料金ではありません。0%・1%、10営業日の結果もJSONに保存しています。', '',
    '| 銘柄 | 期間 | 条件 | 完了数 | 未完了 | 平均 | 中央値 | プラス割合 | 最悪の終点変化 | 期間中の最悪下落 |',
    '|---|---|---|---:|---:|---:|---:|---:|---:|---:|'];
  for(const r of results.filter(r=>r.horizon===20&&r.costPct===0.5)) lines.push(`| ${r.symbol} | ${r.period} | ${r.rule} | ${r.completed} | ${r.pending} | ${pct(r.meanPct)} | ${pct(r.medianPct)} | ${pct(r.positivePct)} | ${pct(r.worstReturnPct)} | ${pct(r.worstPathPct)} |`);
  lines.push('', 'baselineは条件なしで期間内の最初の評価可能日から順に観測する比較群です。条件群とは開始日と件数が異なり、平均値の差を戦略の優位性と解釈できません。プラス割合は将来の上昇確率・勝率ではありません。少数の条件一致、既知の銘柄選択、配当除外、価格改訂、寄付きとの差、未決済資金の拘束、ニュース未評価という限界があります。前期・後期は時間分割であり、実時間の未見データ検証ではありません。');
  writeFileSync(resolve(dir,'price-study-report.md'),lines.join('\n')+'\n',{mode:0o600});
  console.log(JSON.stringify({version:PRICE_RULE_VERSION,through:dataset.through,rows:Object.fromEntries(Object.entries(dataset.symbols).map(([s,r])=>[s,r.length])),report:'private/price-study-report.md'}));
} catch(error) {console.error(error instanceof Error?error.message:'検証を完了できませんでした。');process.exitCode=1;}
