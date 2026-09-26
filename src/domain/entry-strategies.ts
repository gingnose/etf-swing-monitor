import {validateCloses,type Close} from './price-rules.ts';
export const ENTRY_VERSION='entry-strategies-v1';
export type EntryStrategies={symbol:string;version:string;asOf:string|null;close:number|null;breakout:{matched:boolean|null;previousHigh:number|null;distancePct:number|null};longValue:{matched:boolean|null;rankPct:number|null;count:number;required:number};frequency:{from:string;through:string;days:number;updates:number;episodes:number;ratePct:number}|null};
export function entryStrategies(symbol:string,rows:readonly Close[]):EntryStrategies{
 validateCloses(rows);if(!['SOXL','TQQQ'].includes(symbol))throw Error('Unsupported symbol');
 const close=rows.at(-1)?.close??null,high=rows.length>=21?Math.max(...rows.slice(-21,-1).map(r=>r.close)):null;
 const past=rows.slice(-757,-1),rank=rows.length>=757?(past.filter(r=>r.close<close!).length+past.filter(r=>r.close===close!).length/2)/756:null;
 const prices=rows.map(r=>r.close);
 let updates=0,episodes=0,previous=false;
 for(let i=20;i<rows.length;i++){let maximum=-Infinity;for(let j=i-20;j<i;j++)maximum=Math.max(maximum,prices[j]);const match=prices[i]>maximum;if(match){updates++;if(!previous)episodes++;}previous=match;}
 return {symbol,version:ENTRY_VERSION,asOf:rows.at(-1)?.date??null,close,
  breakout:{matched:high===null?null:close!>high,previousHigh:high,distancePct:high===null?null:(close!/high-1)*100},
  longValue:{matched:rank===null?null:rank<=.1,rankPct:rank===null?null:100*rank,count:Math.max(0,rows.length-1),required:756},
  frequency:rows.length<21?null:{from:rows[20].date,through:rows.at(-1)!.date,days:rows.length-20,updates,episodes,ratePct:100*updates/(rows.length-20)}};
}
