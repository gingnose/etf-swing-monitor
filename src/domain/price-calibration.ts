import {validateCloses,type Close} from './price-rules.ts';
export const CALIBRATION_VERSION='price-calibration-v1';
export const START=271; // 20 observations plus 252 PRIOR deviation observations, same start for every rule.
export type Feature={date:string;close:number;z:number|null;logZ:number|null;robustZ:number|null;gap:number;rank:number|null;trend:boolean;vol:number|null;volHigh:boolean|null};
export const mean=(a:number[])=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
export function quantile(a:number[],p:number){if(!a.length)return null;const s=[...a].sort((a,b)=>a-b),k=(s.length-1)*p,lo=Math.floor(k);return s[lo]+(s[Math.ceil(k)]-s[lo])*(k-lo);}
function sd(a:number[]){const m=mean(a)!;return Math.sqrt(mean(a.map(x=>(x-m)**2))!);}
export function features(rows:readonly Close[]):Feature[]{
 validateCloses(rows);const result:Feature[]=[];const gaps:number[]=[],vols:(number|null)[]=[];
 for(let i=0;i<rows.length;i++){
  const recent=rows.slice(Math.max(0,i-19),i+1).map(r=>r.close),logs=recent.map(Math.log),m=mean(recent)!,lm=mean(logs)!;
  const valid=recent.length===20,scale=sd(recent),ls=sd(logs),med=quantile(logs,.5)!,mad=quantile(logs.map(x=>Math.abs(x-med)),.5)!;
  const gap=valid?Math.log(rows[i].close/m):NaN;
  const prior=gaps.slice(-252);let rank:number|null=null;
  if(prior.length===252&&prior.every(Number.isFinite)&&Number.isFinite(gap))rank=(prior.filter(x=>x<gap).length+.5*prior.filter(x=>x===gap).length)/252;
  const returns=i>=20?rows.slice(i-19,i+1).map((r,n)=>Math.log(r.close/rows[i-20+n].close)):[];
  const vol=returns.length===20?sd(returns):null,previousVol=vols.slice(-252);
  const volHigh=vol!==null&&previousVol.length===252&&previousVol.every(v=>v!==null)?vol>quantile(previousVol as number[],.5)!:null;
  const sma200=i>=199?mean(rows.slice(i-199,i+1).map(r=>r.close)):null;
  const sma50=i>=49?mean(rows.slice(i-49,i+1).map(r=>r.close)):null;
  const old50=i>=54?mean(rows.slice(i-54,i-4).map(r=>r.close)):null;
  result.push({date:rows[i].date,close:rows[i].close,z:valid&&scale>1e-12?(rows[i].close-m)/scale:null,logZ:valid&&ls>1e-12?(Math.log(rows[i].close)-lm)/ls:null,
   robustZ:valid&&mad>1e-12?(Math.log(rows[i].close)-med)/(1.4826*mad):null,gap,rank,
   trend:sma200!==null&&sma50!==null&&old50!==null&&rows[i].close>sma200&&sma50>sma200&&sma50>old50,vol,volHigh});
  gaps.push(gap);vols.push(vol);
 }
 return result;
}
export const RULES=[
 {id:'bb2',label:'価格z≤−2',family:'core',trend:false,kind:'z',cut:-2},
 {id:'bb2-trend',label:'価格z≤−2＋上昇傾向',family:'core',trend:true,kind:'z',cut:-2},
 {id:'bb2-reentry',label:'−2σから内側へ回復＋上昇傾向',family:'core',trend:true,kind:'reentry',cut:-2},
 {id:'log2-trend',label:'対数z≤−2＋上昇傾向',family:'core',trend:true,kind:'logZ',cut:-2},
 {id:'rank10-trend',label:'過去252日の下位10%＋上昇傾向',family:'core',trend:true,kind:'rank',cut:.1},
 {id:'mad2-trend',label:'中央値/MAD z≤−2＋上昇傾向',family:'core',trend:true,kind:'robustZ',cut:-2},
 {id:'bb15-trend',label:'価格z≤−1.5＋上昇傾向',family:'sensitivity',trend:true,kind:'z',cut:-1.5},
 {id:'bb25-trend',label:'価格z≤−2.5＋上昇傾向',family:'sensitivity',trend:true,kind:'z',cut:-2.5},
 {id:'bb3-trend',label:'価格z≤−3＋上昇傾向',family:'sensitivity',trend:true,kind:'z',cut:-3},
 {id:'rank5-trend',label:'過去252日の下位5%＋上昇傾向',family:'sensitivity',trend:true,kind:'rank',cut:.05},
 {id:'rank15-trend',label:'過去252日の下位15%＋上昇傾向',family:'sensitivity',trend:true,kind:'rank',cut:.15},
 {id:'upper2',label:'上側2σ到達後',family:'exit-diagnostic',trend:false,kind:'upperZ',cut:2},
 {id:'upper90',label:'過去252日の上位10%到達後',family:'exit-diagnostic',trend:false,kind:'upperRank',cut:.9},
] as const;
export type Rule=typeof RULES[number];
export function matches(f:Feature[],i:number,rule:Rule){
 if(i<START||i>=f.length||rule.trend&&!f[i].trend)return false;
 const current=f[i],previous=f[i-1];
 if(rule.kind==='reentry')return previous.z!==null&&current.z!==null&&previous.z<rule.cut&&current.z>=rule.cut;
 if(rule.kind==='upperZ')return current.z!==null&&current.z>=rule.cut;
 if(rule.kind==='upperRank')return current.rank!==null&&current.rank>=rule.cut;
 const value=current[rule.kind];return value!==null&&value<=rule.cut;
}
export type Event={signalDate:string;entryDate:string;exitDate:string;returnPct:number;worstPathPct:number;bestPathPct:number;trend:boolean;volHigh:boolean|null};
export function study(rows:readonly Close[],f:Feature[],from:string,through:string,horizon:number,rule:Rule|null,costPct:number,trendControl=false){
 if(!Number.isInteger(horizon)||horizon<1||!Number.isFinite(costPct)||costPct<0||f.length!==rows.length||from>through)throw Error('Invalid study inputs');
 let signals=0,pending=0,overlapSkipped=0,occupied=-1;const events:Event[]=[];
 for(let i=START;i<rows.length;i++){
  if(rows[i].date<from||rows[i].date>through||rule&&!matches(f,i,rule)||!rule&&trendControl&&!f[i].trend)continue;
  signals++;
  if(i<=occupied){overlapSkipped++;continue;}
  const entry=i+1,exit=entry+horizon;
  if(exit>=rows.length||rows[exit].date>through){pending++;continue;}
  const base=rows[entry].close,path=rows.slice(entry,exit+1).map(r=>(r.close/base-1)*100);
  events.push({signalDate:rows[i].date,entryDate:rows[entry].date,exitDate:rows[exit].date,returnPct:(rows[exit].close/base-1)*100-costPct,
   worstPathPct:Math.min(0,...path)-costPct,bestPathPct:Math.max(0,...path)-costPct,trend:f[i].trend,volHigh:f[i].volHigh});occupied=exit;
 }
 return {signals,pending,overlapSkipped,...summarize(events),events};
}
export function summarize(events:Event[]){const r=events.map(e=>e.returnPct);return {completed:r.length,meanPct:mean(r),medianPct:quantile(r,.5),positivePct:r.length?100*r.filter(x=>x>0).length/r.length:null,
 worstReturnPct:r.length?Math.min(...r):null,worstPathPct:events.length?Math.min(...events.map(e=>e.worstPathPct)):null,medianWorstPathPct:quantile(events.map(e=>e.worstPathPct),.5)};}
