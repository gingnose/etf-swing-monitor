import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readPrivateConfig } from './private-config.mjs';
const root = resolve(import.meta.dirname, '..');
try {
  const values = readPrivateConfig(root);
  const required = ['OWNER_TOKEN_HASH','VAPID_PUBLIC_KEY','VAPID_PRIVATE_KEY','VAPID_SUBJECT','ALPACA_API_KEY','ALPACA_API_SECRET'];
  if (required.some(k => !values[k])) throw new Error('必要なSecretが未入力です。.dev.varsを確認してください。');
  const result = spawnSync(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'), 'secret', 'bulk', '--config', 'wrangler.deploy.jsonc'], {
    cwd: root, input: JSON.stringify(values), stdio: ['pipe', 'inherit', 'inherit'],
  });
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Secretを登録できませんでした。');
  process.exitCode = 1;
}
