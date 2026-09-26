import type {Priority} from './news-priority.ts';
export type NewsReview={symbol:string;state:'concerns'|'not-detected'|'insufficient';incomplete:boolean;checkedAt:string;count:number;support:{title:string;url:string;reason:string}[];reasons:{title:string;url:string;reason:string}[]};
export function summarizeNewsReview(articles:{title:string;url:string;publishedAt:string;priority:Priority;evidence:{targets:string[]}}[],sources:{state:string;lastSuccess:string|null}[],now:Date):NewsReview[]{
 const incomplete=sources.length!==3||sources.some(s=>s.state!=='current'||!s.lastSuccess||Date.parse(s.lastSuccess)<+now-2*3600000);
 return ['SOXL','TQQQ'].map(symbol=>{
  const relevant=articles.filter(a=>a.evidence.targets.includes(symbol)&&Date.parse(a.publishedAt)>=+now-7*86400000&&Date.parse(a.publishedAt)<=+now);
  const concerns=relevant.filter(a=>a.priority.concern);
  const seen=new Set<string>();
  const support=incomplete?[]:relevant.filter(a=>a.priority.direction==='positive'&&!a.priority.concern&&a.priority.fresh&&a.priority.level==='critical'&&a.priority.eventKey!==null).filter(a=>{const key=a.priority.eventKey!;if(seen.has(key))return false;seen.add(key);return true;}).slice(0,3).map(a=>({title:a.title,url:a.url,reason:a.priority.reason}));
  return{symbol,state:concerns.length?'concerns':incomplete||!relevant.length?'insufficient':'not-detected',incomplete,checkedAt:now.toISOString(),count:concerns.length,support,reasons:concerns.slice(0,3).map(a=>({title:a.title,url:a.url,reason:a.priority.reason}))};
 });
}
