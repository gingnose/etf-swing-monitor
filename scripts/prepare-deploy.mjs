import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
const root = resolve(import.meta.dirname, '..');
const id = process.argv[2];
if (!id || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(id) || /^0+(?:-0+)+$/.test(id)) {
  console.error('使用方法: npm run deploy:prepare -- <Cloudflare D1 database_id>'); process.exit(1);
}
const target = resolve(root, 'wrangler.deploy.jsonc');
if (existsSync(target)) { console.error('既存のデプロイ設定を上書きしません。'); process.exit(1); }
const config = JSON.parse(readFileSync(resolve(root, 'wrangler.jsonc'), 'utf8'));
config.d1_databases[0].database_id = id;
writeFileSync(target, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log('非公開のデプロイ設定を作成しました。無料プランであることを確認してからセットアップ手順に進んでください。');
