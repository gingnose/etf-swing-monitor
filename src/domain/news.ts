export const NEWS_VERSION='news-evidence-v1';
export const NEWS_SOURCES=['alpaca','fed','nvidia'] as const;
export type NewsSource=typeof NEWS_SOURCES[number];
export const SOURCE_NAMES={alpaca:'Benzinga（Alpaca経由）',fed:'FRB・金融政策発表',nvidia:'NVIDIA公式ニュース'};
export type NewsInput={title:string;url:string;publishedAt:string;updatedAt:string|null;symbols:string[]};
export type NewsEvidence={version:string;targets:string[];reasons:string[];topics:string[];reviewRequired:boolean;sourceKind:'official'|'reporting';verification:'source-only';direction:'unknown'};
const semis=['NVDA','AMD','AVGO','TSM','INTC','MU','QCOM','AMAT','LRCX','KLAC'];
const tech=['AAPL','MSFT','AMZN','GOOGL','GOOG','META','TSLA'];
export const NEWS_QUERY_SYMBOLS=['SOXL','TQQQ',...semis,...tech].join(',');
export function canonicalNewsUrl(value:string,source:NewsSource) {
  const url=new URL(value);
  const allowed=source==='fed'?['www.federalreserve.gov']:source==='nvidia'?['nvidianews.nvidia.com','blogs.nvidia.com','www.nvidia.com']:['www.benzinga.com','benzinga.com'];
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.port||!allowed.includes(url.hostname)) throw new Error('記事リンクの出所を確認できません。');
  url.protocol='https:';url.hash='';if(url.hostname==='benzinga.com')url.hostname='www.benzinga.com';
  for(const key of [...url.searchParams.keys()])if(/^utm_|^(fbclid|gclid)$/i.test(key))url.searchParams.delete(key);
  if(url.toString().length>2048)throw new Error('記事リンクが長すぎます。');
  return url.toString();
}
export function normalizeNews(raw:NewsInput,source:NewsSource,now:Date):NewsInput {
  if(typeof raw.title!=='string'||raw.title.length>1000||typeof raw.url!=='string'||!Array.isArray(raw.symbols))throw new Error('記事形式が不正です。');
  const title=raw.title.replace(/<[^>]*>/g,' ').replace(/[\u0000-\u001f\u007f]/g,' ').replace(/\s+/g,' ').trim();
  if(!title||title.length>500)throw new Error('記事見出しが不正です。');
  function timestamp(value:string) {
    if(typeof value!=='string'||value.length>80||!/(Z|[+-]\d\d:\d\d|GMT|UTC)$/i.test(value)||!Number.isFinite(Date.parse(value)))throw new Error('記事日時が不正です。');
    const iso=value.match(/^(\d{4})-(\d{2})-(\d{2})T/);
    if(iso&&new Date(Date.UTC(Number(iso[1]),Number(iso[2])-1,Number(iso[3]))).toISOString().slice(0,10)!==value.slice(0,10))throw new Error('記事日付が不正です。');
    const time=new Date(value);
    if(time.getTime()>now.getTime()||time.getUTCFullYear()<2000)throw new Error('記事日時が範囲外です。');
    return time.toISOString();
  }
  const publishedAt=timestamp(raw.publishedAt),updatedAt=raw.updatedAt?timestamp(raw.updatedAt):null;
  if(updatedAt&&updatedAt<publishedAt)throw new Error('記事の更新日時が公開日時より前です。');
  const symbols=[...new Set(raw.symbols.filter(s=>typeof s==='string'&&/^[A-Z.]{1,10}$/.test(s)))].slice(0,50).sort();
  return {title,url:canonicalNewsUrl(raw.url,source),publishedAt,updatedAt,symbols};
}
export function newsEvidence(item:NewsInput,source:NewsSource):NewsEvidence {
  const targets=new Set<string>(),reasons:string[]=[],topics:string[]=[];
  if(source==='fed'){targets.add('SOXL');targets.add('TQQQ');reasons.push('FRBの金融政策発表。金利・市場環境との関連を確認');}
  if(source==='nvidia'){targets.add('SOXL');targets.add('TQQQ');reasons.push('NVIDIA自身の発信。業績や半導体・大型技術株への関連を確認');}
  for(const symbol of item.symbols){
    if(symbol==='SOXL'||symbol==='TQQQ'){targets.add(symbol);reasons.push(`${symbol}のニュースタグ`);}
    else if(semis.includes(symbol)){targets.add('SOXL');if(['NVDA','AMD','AVGO','INTC','MU','QCOM','AMAT','LRCX','KLAC'].includes(symbol))targets.add('TQQQ');reasons.push(`${symbol}のニュースタグ（半導体関連の手掛かり）`);}
    else if(tech.includes(symbol)){targets.add('TQQQ');reasons.push(`${symbol}のニュースタグ（大型技術株関連の手掛かり）`);}
  }
  const title=item.title;
  if(/\b(federal reserve|fomc|interest rates?|monetary policy|inflation)\b/i.test(title)||source==='fed'){topics.push('金融政策・物価');targets.add('SOXL');targets.add('TQQQ');}
  if(/\b(export|sanctions?|restrictions?|bans?|tariffs?|regulat(?:ion|ory))\b/i.test(title))topics.push('規制・輸出・通商');
  if(/\b(earnings|revenue|guidance|outlook|forecast|quarter(?:ly)?)\b/i.test(title))topics.push('業績・見通し');
  if(/\b(chips?|semiconductors?|data centers?|ai|artificial intelligence|supply|capacity)\b/i.test(title))topics.push('半導体・AI・供給');
  if(!topics.length)topics.push('その他・内容確認が必要');
  return {version:NEWS_VERSION,targets:[...targets].sort(),reasons:reasons.slice(0,6),topics,reviewRequired:topics.some(t=>['金融政策・物価','規制・輸出・通商','業績・見通し'].includes(t)),sourceKind:source==='alpaca'?'reporting':'official',verification:'source-only',direction:'unknown'};
}
export function headlineKey(title:string){return title.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();}
