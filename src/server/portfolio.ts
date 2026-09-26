import { AppError, type Env } from './types.ts';
import { digest, limit } from './auth.ts';
import { applyPortfolioChange, portfolioView, PortfolioError, type PortfolioLedger } from '../domain/portfolio.ts';

type StateRow = {revision:number;payload:string|null};
type Receipt = {request_hash:string;applied_revision:number};
const idPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function replay(receipt: Receipt, hash: string) {
  if (receipt.request_hash !== hash) throw new AppError(409,'同じ登録IDが別の内容に使われています。状態を更新してください。');
  return {ok:true,revision:receipt.applied_revision,replayed:true};
}
async function receipt(env:Env,id:string) {
  return env.DB.prepare('SELECT request_hash,applied_revision FROM portfolio_requests WHERE request_id=?').bind(id).first<Receipt>();
}
export async function readPortfolio(env: Env) {
  const row = await env.DB.prepare('SELECT revision,payload FROM portfolio_state WHERE id=1').first<StateRow>();
  if (!row) throw new AppError(503,'資金管理の初期設定が必要です。');
  return {...portfolioView(row.payload ? JSON.parse(row.payload) as PortfolioLedger : null),revision:row.revision};
}
export async function writePortfolio(env: Env, body: Record<string,unknown>, now = new Date()) {
  if (typeof body.requestId !== 'string' || !idPattern.test(body.requestId) || !Number.isSafeInteger(body.revision) || Number(body.revision)<0 || Number(body.revision)>1_000_000_000 || !body.change || typeof body.change!=='object') {
    throw new AppError(400,'保存する内容と更新番号を確認してください。');
  }
  const id=body.requestId, expected=Number(body.revision);
  const requestHash=await digest(JSON.stringify({revision:expected,change:body.change}));
  const previous=await receipt(env,id);
  if (previous) return replay(previous,requestHash);
  await limit(env,'portfolio-write',60,3600_000,now.getTime());
  const row=await env.DB.prepare('SELECT revision,payload FROM portfolio_state WHERE id=1').first<StateRow>();
  if (!row) throw new AppError(503,'資金管理の初期設定が必要です。');
  if (row.revision!==expected) {
    const raced = await receipt(env,id);
    if (raced) return replay(raced,requestHash);
    throw new AppError(409,'別の画面で記録が更新されています。最新の状態を読み込んでから保存してください。');
  }
  // Bound immutable receipts as well as the journal; replay remains available at capacity.
  if (row.revision >= 10_000) throw new AppError(409,'台帳の更新上限（10,000回）です。書き出して管理者に移行を依頼してください。');
  let next: PortfolioLedger;
  try {
    next=applyPortfolioChange(row.payload ? JSON.parse(row.payload) as PortfolioLedger : null,body.change,id,new Date(now.getTime()+9*3600_000).toISOString().slice(0,10));
  } catch (error) {
    if (error instanceof PortfolioError) throw new AppError(400,error.message);
    throw error;
  }
  const nextRevision=expected+1;
  // Atomic compare-and-swap plus receipt: duplicate requests cannot apply twice,
  // even when their initial receipt lookup races another in-flight transaction.
  const writes=await env.DB.batch([
    env.DB.prepare(`UPDATE portfolio_state SET revision=?,payload=?,last_request_id=?,updated_at=?
      WHERE id=1 AND revision=? AND NOT EXISTS(SELECT 1 FROM portfolio_requests WHERE request_id=?)`)
      .bind(nextRevision,JSON.stringify(next),id,now.toISOString(),expected,id),
    env.DB.prepare(`INSERT INTO portfolio_requests(request_id,request_hash,applied_revision,change_json,created_at)
      SELECT ?,?,?,?,? FROM portfolio_state WHERE id=1 AND revision=? AND last_request_id=? AND NOT EXISTS(SELECT 1 FROM portfolio_requests WHERE request_id=?)`)
      .bind(id,requestHash,nextRevision,JSON.stringify(body.change),now.toISOString(),nextRevision,id,id),
  ]);
  if (writes[0].meta.changes===1) return {ok:true,revision:nextRevision,replayed:false};
  const committed=await receipt(env,id);
  if (committed) return replay(committed,requestHash);
  throw new AppError(409,'記録が同時に更新されました。最新の状態を読み込んでください。');
}
