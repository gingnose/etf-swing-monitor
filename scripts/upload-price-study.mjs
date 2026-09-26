import {readFileSync,writeFileSync,rmSync} from 'node:fs';
import {resolve} from 'node:path';
import {execFileSync} from 'node:child_process';
import {PRICE_RULE_VERSION} from '../src/domain/price-rules.ts';
const root=resolve(import.meta.dirname,'..'),sqlFile=resolve(root,'private/price-study-upload.sql');
try {
  const report=JSON.parse(readFileSync(resolve(root,'private/price-study-report.json'),'utf8'));
  if(report.version!==PRICE_RULE_VERSION||!Array.isArray(report.results)||report.results.length!==72)throw new Error('検証結果の形式が一致しません。');
  const evaluation={version:report.version,createdAt:report.createdAt,fetchedAt:report.fetchedAt,inputHash:report.inputHash,
    rows:report.results.filter(r=>r.horizon===20&&r.costPct===0.5).map(({events,...r})=>r)};
  if(evaluation.rows.length!==12)throw new Error('検証結果の件数が不正です。');
  const quote=s=>"'"+s.replaceAll("'","''")+"'";
  // Preserve the first evaluation of a rule version, including unfavorable outcomes.
  const sql=`INSERT OR IGNORE INTO price_rule_evaluations(version,created_at,payload) VALUES (${quote(report.version)},${quote(report.createdAt)},${quote(JSON.stringify(evaluation))});`;
  writeFileSync(sqlFile,sql,{mode:0o600});
  execFileSync(process.execPath,[resolve(root,'node_modules/wrangler/bin/wrangler.js'),'d1','execute','DB','--remote','--config',resolve(root,'wrangler.deploy.jsonc'),'--file',sqlFile],{cwd:root,stdio:'pipe'});
  console.log('検証結果の集計を所有者専用DBへ保存しました。');
} catch {console.error('検証結果を保存できませんでした。設定とローカルのレポートを確認してください。');process.exitCode=1;}
finally{rmSync(sqlFile,{force:true});}
