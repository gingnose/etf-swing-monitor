import { generateKeyPairSync, randomBytes, createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
if (existsSync(resolve(root, '.dev.vars')) || existsSync(resolve(root, 'private/owner-token.txt'))) {
  console.error('既存の設定を上書きしません。.dev.vars と private/ を確認してください。');
  process.exit(1);
}
mkdirSync(resolve(root, 'private'), { recursive: true, mode: 0o700 });
const token = randomBytes(32).toString('hex');
const hash = createHash('sha256').update(token).digest('hex');
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pub = publicKey.export({ format: 'jwk' });
const priv = privateKey.export({ format: 'jwk' });
const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')]);
const values = {
  OWNER_TOKEN_HASH: hash,
  VAPID_PUBLIC_KEY: raw.toString('base64url'),
  VAPID_PRIVATE_KEY: priv.d,
  VAPID_SUBJECT: 'https://github.com/gingnose/etf-swing-monitor',
  ALPACA_API_KEY: '', ALPACA_API_SECRET: '',
};
writeFileSync(resolve(root, '.dev.vars'), Object.entries(values).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
writeFileSync(resolve(root, 'private/owner-token.txt'), token + '\n', { mode: 0o600, flag: 'wx' });
console.log('初期設定を作成しました。秘密の値は画面に出力していません。');
console.log('所有者キー: private/owner-token.txt（ログイン画面に入力）');
console.log('APIキーの入力先: .dev.vars（Alpacaのキーをローカルで入力）');
console.log('次: npm run dev');
