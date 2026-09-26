import type {NewsSource} from './news.ts';
export const PRIORITY_VERSION='news-priority-v1';
export type Priority={version:string;level:'critical'|'important'|'normal';score:number;direction:'positive'|'negative'|'mixed'|'unknown';reason:string;uncertainty:string;eventKey:string|null;fresh:boolean;recent:boolean;concern:boolean};
export type PriorityInput={title:string;source:NewsSource;publishedAt:string;updatedAt:string|null;symbols:string[]};
// Deliberately conservative headline rules. Scores order attention, not returns or probabilities.
export function prioritizeNews(item:PriorityInput,now:Date):Priority {
 const t=item.title.toLowerCase();const age=+now-Date.parse(item.publishedAt),fresh=age>=0&&age<=24*3600000;
 const uncertain=/\b(rumou?rs?|reportedly|may|might|could|would|expects?|expected|predicts?|prediction|forecast|analysts?|preview|what if|den(?:y|ies|ied)|not|no|false|unconfirmed|consider(?:s|ing)?|weighs?|propos(?:es|ed|al)|plans? to|seeks? to)\b|\?/.test(t);
 const entity=item.source==='fed'?'FED':/^(us |u\.s\. |united states |white house |commerce department )/.test(t)?'US':item.source==='nvidia'||/\bnvidia\b/.test(t)?'NVDA':/\bamd\b|advanced micro devices/.test(t)?'AMD':/\b(microsoft|msft)\b/.test(t)?'MSFT':(/\b(us|united states|white house|commerce department)\b/.test(t)||t.startsWith('u.s.'))?'US':null;
 const specific=entity==='NVDA'||entity==='AMD'||entity==='MSFT';
 const guidance=specific&&/^(nvidia|amd|advanced micro devices|microsoft)(?: [a-z0-9-]+){0,3} (raises?|raised|lifts?|boosts?|cuts?|cut|lowers?|lowered|slashes?)\b.{0,45}\b(guidance|outlook)\b/.test(t);
 const up=guidance&&/\b(raises?|raised|lifts?|boosts?)\b/.test(t),down=guidance&&/\b(cuts?|cut|lowers?|lowered|slashes?)\b/.test(t);
 const policy=item.source==='fed'&&/^(federal reserve|fomc|federal open market committee) (issues? fomc statement|(raises?|lowers?|cuts?|maintains?|keeps?) (the )?(target range|interest rates|federal funds|rates))\b/.test(t);
 const results=item.source==='nvidia'&&/^nvidia (announces|reports) (financial results|record .{0,30}revenue)/.test(t);
 const exportAction=entity==='US'&&/^(us|u\.s\.|united states|white house|commerce department)(?: [a-z0-9-]+){0,3} (imposes?|tightens?|restricts?|bans?|lifts?|eases?|removes?)\b/.test(t)&&/\b(chip|chips|semiconductor|semiconductors|nvidia|amd)\b/.test(t)&&/\b(export|exports|restrictions|ban)\b/.test(t);
 const core=policy||results||guidance||exportAction;
 const relevant=policy||results||item.symbols.some(s=>['SOXL','TQQQ','NVDA','AMD','MSFT','AVGO','TSM','INTC','MU','QCOM','AMAT','LRCX','KLAC','AAPL','AMZN','GOOG','GOOGL','META','TSLA'].includes(s))||item.source==='nvidia';
 const theme=/\b(earnings|revenue|guidance|outlook|export|exports|sanctions|tariffs|inflation|fomc|monetary|rates|supply|shortage|disruption|delays?|misses|weak|decline|downgrades?)\b/.test(t);
 const roundup=/\b(week in|weekly|roundup|round-up|bulls and bears|stocks to|top \d+|price target|upgrades?|downgrades?|says|said|sees|why|how|but|while|after)\b/.test(t);
 const critical=core&&relevant&&fresh&&!uncertain&&!roundup;
 let level:Priority['level']=critical?'critical':relevant&&(core||theme)?'important':'normal';
 let direction:Priority['direction']='unknown';
 if(!uncertain&&!roundup){if(guidance)direction=up&&down?'mixed':up?'positive':down?'negative':'unknown';else if(exportAction){const good=/\b(lifts?|eases?|removes?)\b/.test(t),bad=/\b(imposes?|tightens?|restricts?|bans?)\b/.test(t);direction=good&&bad?'mixed':good?'positive':bad?'negative':'unknown';}}
 const concern=(policy&&/\braises?\b/.test(t))||direction==='negative'||direction==='mixed'||(direction==='unknown'&&/\b(cuts?|lowers?|slashes?|restrictions?|sanctions?|tariffs?|bans?|shortage|disruption|delay|delays|misses|weak|decline|downgrades?)\b/.test(t));
 if(concern&&relevant&&level==='normal')level='important';
 const category=policy?'monetary-decision':results?'earnings-release':guidance?'guidance-change':exportAction?'chip-export-policy':null;
 const reason=policy?'FRBの金融政策決定・声明':results?'NVIDIAの公式決算発表':guidance?'主要企業の業績見通し変更':exportAction?'米国の半導体輸出政策の変更':theme?'業績・政策・供給に関する関連情報':concern?'制限・悪化などの表現を含むため確認が必要':'直接的な重要事実を見出しから特定できません';
 return {version:PRIORITY_VERSION,level,concern,recent:age>=0&&age<=7*86400000,score:(level==='critical'?100:level==='important'?50:0)+(item.source!=='alpaca'?10:0)+(fresh?5:0),direction,
 reason:reason+(uncertain?'（予想・否定などの表現を含む）':roundup?'（解説・総括記事）':''),
 uncertainty:'見出しと配信元による推定。本文・真偽・織り込み状況は未確認で、ETFの値動きや売買の推奨を示しません。',
 eventKey:critical?`${category}:${entity}:${direction}:${item.publishedAt.slice(0,10)}`:null,fresh};
}
