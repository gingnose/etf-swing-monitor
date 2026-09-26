import { type Env, AppError } from './types.ts';
import { readResearch } from './history.ts';
import { PRICE_RULE_VERSION, WINDOW, priceDecision, type PriceDecision } from '../domain/price-rules.ts';
import type { Snapshot } from '../domain/indicators.ts';

export async function currentPriceRules(env:Env,now=new Date()) {
  const research=await readResearch(env,now);
  if(research.state!=='available') return {version:PRICE_RULE_VERSION,state:research.state,detail:research.detail,strategyInputs:[],decisions:[] as PriceDecision[],inputHash:null as string|null};
  const snapshots=research.snapshots as Snapshot[];
  if(snapshots.length!==2||new Set(snapshots.map(s=>s.symbol)).size!==2||snapshots.some(s=>s.feed!=='sip'||s.adjustment!=='split'||s.closes.at(-1)?.date!==s.asOf)) throw new AppError(503,'価格の取得元・調整方式が一致しません。条件判定を保留します。');
  const decisions=snapshots.map(s=>priceDecision(s.symbol,s.closes.slice(-WINDOW)));
  if(decisions[0].asOf!==decisions[1].asOf) throw new AppError(503,'両銘柄の日付が一致しません。');
  return {version:PRICE_RULE_VERSION,state:'available' as const,detail:'価格条件の仮説を検証中です。購入推奨・上昇確率ではありません。ニュースを含めた運用成績と購入予算は未評価です。',strategyInputs:snapshots.map(s=>({symbol:s.symbol,closes:s.closes})),decisions,inputHash:research.inputHash as string};
}
export async function observePriceRules(env:Env,now=new Date()) {
  const current=await currentPriceRules(env,now);
  if(current.state!=='available'||current.decisions.some(d=>d.state==='insufficient')) throw new AppError(409,'最新の205営業日分の価格が揃っていないため観測を保存できません。');
  const result=await env.DB.prepare(`INSERT OR IGNORE INTO price_rule_observations(version,market_date,observed_at,input_hash,payload) VALUES (?,?,?,?,?)`)
    .bind(PRICE_RULE_VERSION,current.decisions[0].asOf,now.toISOString(),current.inputHash,JSON.stringify(current.decisions)).run();
  return {ok:true,recorded:result.meta.changes===1};
}
export async function readPriceRules(env:Env,now=new Date()) {
  const current=await currentPriceRules(env,now);
  const rows=await env.DB.prepare('SELECT market_date,observed_at,input_hash,payload FROM price_rule_observations WHERE version=? ORDER BY market_date DESC LIMIT 30').bind(PRICE_RULE_VERSION)
    .all<{market_date:string;observed_at:string;input_hash:string;payload:string}>();
  const evaluation=await env.DB.prepare('SELECT payload FROM price_rule_evaluations WHERE version=?').bind(PRICE_RULE_VERSION).first<{payload:string}>();
  return {...current,evaluation:evaluation?JSON.parse(evaluation.payload):null,observations:rows.results.map(r=>({marketDate:r.market_date,observedAt:r.observed_at,inputHash:r.input_hash,decisions:JSON.parse(r.payload) as PriceDecision[]}))};
}
