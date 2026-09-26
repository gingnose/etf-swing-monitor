import { indicators } from './indicators.ts';

// Hypotheses frozen before the first retrospective evaluation; not fitted returns.
export const PRICE_RULE_VERSION = 'price-hypotheses-v1';
export const WINDOW = 205;
export type Close = {date:string;close:number};
export type PriceRule = 'pullback'|'recovery';
export type PriceDecision = {
  version:string;symbol:string;asOf:string|null;state:'insufficient'|'pause'|'waiting'|'matched';
  matched:PriceRule[];checks:{label:string;passed:boolean}[];
  values:{close:number;sma20:number;sma50:number;sma200:number;rsi14:number;sma50FiveAgo:number}|null;
};
export function validateCloses(rows:readonly Close[]) {
  for(let i=0;i<rows.length;i++) {
    const r=rows[i];
    if(!/^\d{4}-\d{2}-\d{2}$/.test(r.date)||!Number.isFinite(Date.parse(r.date))||new Date(r.date).toISOString().slice(0,10)!==r.date||!Number.isFinite(r.close)||r.close<=0) throw new Error('Invalid daily closes');
    if(i && (r.date<=rows[i-1].date || Date.parse(r.date)-Date.parse(rows[i-1].date)>7*86400_000)) throw new Error('Unordered or incomplete daily closes');
  }
}
export function priceDecision(symbol:string, rows:readonly Close[]):PriceDecision {
  if(!['SOXL','TQQQ'].includes(symbol)) throw new Error('Unsupported symbol');
  validateCloses(rows);
  const base={version:PRICE_RULE_VERSION,symbol,asOf:rows.at(-1)?.date??null};
  if(rows.length<WINDOW) return {...base,state:'insufficient',matched:[],checks:[],values:null};
  // Fixed window makes live and retrospective RSI initialization identical.
  const c=rows.slice(-WINDOW).map(r=>r.close), m=indicators(c), previous=indicators(c.slice(0,-1));
  const close=c.at(-1)!, prior=c.at(-2)!;
  const sma20=m.sma20!,sma50=m.sma50!,sma200=m.sma200!,rsi14=m.rsi14!;
  const sma50FiveAgo=c.slice(-55,-5).reduce((a,b)=>a+b,0)/50;
  const checks=[
    {label:'終値が200日平均より上',passed:close>sma200},
    {label:'50日平均が200日平均より上',passed:sma50>sma200},
    {label:'50日平均が5営業日前より上',passed:sma50>sma50FiveAgo},
    {label:'RSI14が70以下',passed:rsi14<=70},
  ];
  const trend=checks.every(c=>c.passed);
  const pullback=trend && close<sma20 && prior<previous.sma20! && close>prior && rsi14>=40 && rsi14<=60;
  const recovery=trend && prior<=previous.sma20! && close>sma20 && rsi14>=45 && rsi14<=65;
  const matched:PriceRule[]=[...(pullback?['pullback' as const]:[]),...(recovery?['recovery' as const]:[])];
  return {...base,state:!trend?'pause':matched.length?'matched':'waiting',matched,checks,
    values:{close,sma20,sma50,sma200,rsi14,sma50FiveAgo}};
}

export type EventSummary={signals:number;completed:number;pending:number;overlapSkipped:number;meanPct:number|null;medianPct:number|null;positivePct:number|null;worstReturnPct:number|null;worstPathPct:number|null;events:{signalDate:string;entryDate:string;exitDate:string;returnPct:number;worstPathPct:number}[]};
// Endpoint studies only: no actual exits, reinvestment, budget or trading performance.
export function eventStudy(symbol:string,rows:readonly Close[],from:string,through:string,horizon:10|20,rule:PriceRule|'baseline',costPct=0):EventSummary {
  validateCloses(rows);
  if(!['SOXL','TQQQ'].includes(symbol)||![10,20].includes(horizon)||!['baseline','pullback','recovery'].includes(rule)) throw new Error('Invalid study rule');
  if(!Number.isFinite(costPct)||costPct<0||costPct>=100||from>through) throw new Error('Invalid study configuration');
  const results:number[]=[],paths:number[]=[],events:EventSummary["events"]=[];
  let signals=0,pending=0,overlapSkipped=0,occupiedThrough=-1;
  for(let i=WINDOW-1;i<rows.length;i++) {
    if(rows[i].date<from||rows[i].date>through) continue;
    if(rule!=='baseline'&&!priceDecision(symbol,rows.slice(Math.max(0,i-WINDOW+1),i+1)).matched.includes(rule)) continue;
    signals++;
    if(i<=occupiedThrough){overlapSkipped++;continue;}
    const entry=i+1,exit=entry+horizon;
    if(exit>=rows.length||rows[exit].date>through){pending++;continue;}
    const start=rows[entry].close;
    // costPct is a hypothetical total round-trip deduction in percentage points.
    results.push((rows[exit].close/start-1)*100-costPct);
    paths.push(Math.min(0,...rows.slice(entry,exit+1).map(r=>(r.close/start-1)*100))-costPct);
    events.push({signalDate:rows[i].date,entryDate:rows[entry].date,exitDate:rows[exit].date,returnPct:results.at(-1)!,worstPathPct:paths.at(-1)!});
    occupiedThrough=exit;
  }
  const ordered=[...results].sort((a,b)=>a-b),n=ordered.length;
  return {signals,completed:n,pending,overlapSkipped,events,
    meanPct:n?results.reduce((a,b)=>a+b,0)/n:null,
    medianPct:n?(ordered[Math.floor((n-1)/2)]+ordered[Math.floor(n/2)])/2:null,
    positivePct:n?100*results.filter(x=>x>0).length/n:null,
    worstReturnPct:n?Math.min(...results):null,worstPathPct:n?Math.min(...paths):null};
}
