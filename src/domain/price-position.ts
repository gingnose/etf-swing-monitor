import {validateCloses, type Close} from './price-rules.ts';
import {mean, quantile} from './price-calibration.ts';

export const POSITION_VERSION = 'price-position-v1';
export const LOOKBACKS = [5,20,63,126,252,756] as const;
export const HORIZONS = [5,20,63,126,252] as const;
export const COMMON_START = 756;
export type Position = {rank:number;newLow:boolean;distanceFromLowPct:number};
export function pricePositions(rows:readonly Close[],lookback:number):(Position|null)[] {
  validateCloses(rows);
  if(!Number.isInteger(lookback)||lookback<1) throw Error('Invalid lookback');
  return rows.map((r,i)=>{
    if(i<lookback)return null;
    const past=rows.slice(i-lookback,i).map(x=>x.close),low=Math.min(...past);
    return {rank:(past.filter(x=>x<r.close).length+past.filter(x=>x===r.close).length/2)/lookback,
      newLow:r.close<low,distanceFromLowPct:(r.close/low-1)*100};
  });
}
export type PositionEvent = {
  signalDate:string;entryDate:string|null;followed:number;hitDay:number|null;
  outcomes:{horizon:number;returnPct:number;worstPathPct:number}[];
};
// Spacing depends only on the signal index, never on future outcomes.
export function positionEvents(rows:readonly Close[],qualifies:readonly boolean[],start=COMMON_START,cooldown=20,costPct=.5):PositionEvent[] {
  validateCloses(rows);
  if(qualifies.length!==rows.length||!Number.isInteger(start)||start<0||!Number.isInteger(cooldown)||cooldown<0||!Number.isFinite(costPct)||costPct<0||costPct>=100) throw Error('Invalid position study');
  const events:PositionEvent[]=[];let last=-Infinity;
  for(let i=start;i<rows.length;i++){
    if(!qualifies[i]||i-last<=cooldown)continue;
    last=i;const entry=i+1;
    if(entry>=rows.length){events.push({signalDate:rows[i].date,entryDate:null,followed:0,hitDay:null,outcomes:[]});continue;}
    const followed=Math.min(252,rows.length-1-entry),returns=rows.slice(entry,entry+followed+1).map(r=>(r.close/rows[entry].close-1)*100-costPct);
    const hit=returns.findIndex((v,d)=>d>0&&v>=10);
    events.push({signalDate:rows[i].date,entryDate:rows[entry].date,followed,hitDay:hit<0?null:hit,
      outcomes:HORIZONS.filter(h=>h<=followed).map(h=>({horizon:h,returnPct:returns[h],worstPathPct:Math.min(...returns.slice(0,h+1))}))});
  }
  return events;
}
export function positionSummary(events:readonly PositionEvent[],horizon:number,commonCohort=true){
  const cohort=commonCohort?events.filter(e=>e.followed===252):events;
  const completed=cohort.flatMap(e=>e.outcomes.filter(x=>x.horizon===horizon));
  const v=completed.map(x=>x.returnPct),paths=completed.map(x=>x.worstPathPct);
  return {n:v.length,excluded:events.length-v.length,meanPct:mean(v),medianPct:quantile(v,.5),p10Pct:quantile(v,.1),positivePct:v.length?100*v.filter(x=>x>0).length/v.length:null,
    worstPathPct:paths.length?Math.min(...paths):null,medianWorstPathPct:quantile(paths,.5)};
}
export function targetSummary(events:readonly PositionEvent[]){
  const full=events.filter(e=>e.followed===252),hit=full.filter(e=>e.hitDay!==null);
  return {completed:full.length,hit:hit.length,notHit:full.length-hit.length,hitPct:full.length?100*hit.length/full.length:null,
    medianDaysAmongHits:quantile(hit.map(e=>e.hitDay!),.5),pending:events.filter(e=>e.entryDate!==null&&e.followed<252).length,
    pendingAlreadyHit:events.filter(e=>e.followed<252&&e.hitDay!==null).length,awaitingEntry:events.filter(e=>e.entryDate===null).length};
}
