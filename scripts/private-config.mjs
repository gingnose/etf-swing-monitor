import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function readPrivateConfig(root) {
  const allowed = ['OWNER_TOKEN_HASH', 'VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT', 'ALPACA_API_KEY', 'ALPACA_API_SECRET'];
  const values = {};
  let contents;
  try { contents = readFileSync(resolve(root, '.dev.vars'), 'utf8'); }
  catch { throw new Error('.dev.vars がありません。npm run setup を実行してください。'); }
  for (const line of contents.split('\n')) {
    const match = line.match(/^([A-Z_]+)=(.*)$/);
    if (!match || !allowed.includes(match[1])) continue;
    const raw = match[2].trim();
    try {
      const value = raw.startsWith('"') ? JSON.parse(raw) : raw;
      if (typeof value !== 'string') throw new Error();
      values[match[1]] = value;
    } catch { throw new Error(`${match[1]} の設定形式を確認してください。値はログへ表示しません。`); }
  }
  return values;
}
