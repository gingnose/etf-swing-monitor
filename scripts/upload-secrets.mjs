import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const allowed = ['OWNER_TOKEN_HASH','VAPID_PUBLIC_KEY','VAPID_PRIVATE_KEY','VAPID_SUBJECT','ALPACA_API_KEY','ALPACA_API_SECRET'];
const values = {};
for (const line of readFileSync(resolve(root, '.dev.vars'), 'utf8').split('\n')) {
  const match = line.match(/^([A-Z_]+)=(.*)$/);
  if (!match || !allowed.includes(match[1])) continue;
  const value = match[2].trim();
  values[match[1]] = value.startsWith('"') ? JSON.parse(value) : value;
}
if (allowed.some(k => !values[k])) { console.error('必要なSecretが未入力です。.dev.varsを確認してください。'); process.exit(1); }
const result = spawnSync(process.execPath, [resolve(root, 'node_modules/wrangler/bin/wrangler.js'), 'secret', 'bulk', '--config', 'wrangler.deploy.jsonc'], {
  cwd: root, input: JSON.stringify(values), stdio: ['pipe', 'inherit', 'inherit'],
});
process.exit(result.status ?? 1);
