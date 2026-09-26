import { AppError, type Env } from './types.ts';

export async function digest(value: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))]
    .map(x => x.toString(16).padStart(2, '0')).join('');
}

export function randomToken(): string {
  return [...crypto.getRandomValues(new Uint8Array(32))].map(x => x.toString(16).padStart(2, '0')).join('');
}

export function requireSameOrigin(request: Request) {
  if (request.headers.get('Origin') !== new URL(request.url).origin || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
    throw new AppError(403, 'このアプリの画面から操作してください。');
  }
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
    throw new AppError(415, 'JSON形式のリクエストが必要です。');
  }
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  // The stream is bounded even if Content-Length is missing or untrusted.
  if (!request.body) throw new AppError(400, '入力が空です。');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > 8192) { await reader.cancel(); throw new AppError(413, '入力が大きすぎます。'); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const value = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new AppError(400, '入力を読み取れませんでした。'); }
}

function cookieName(request: Request) {
  return new URL(request.url).protocol === 'https:' ? '__Host-etf_session' : 'etf_session';
}

export function sessionCookie(request: Request, token: string, age = 60 * 60 * 24 * 30) {
  const secure = new URL(request.url).protocol === 'https:' ? '; Secure' : '';
  return `${cookieName(request)}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${age}${secure}`;
}

function getToken(request: Request) {
  const name = cookieName(request) + '=';
  return (request.headers.get('Cookie') || '').split(';').map(x => x.trim()).find(x => x.startsWith(name))?.slice(name.length);
}

export async function requireOwner(request: Request, env: Env) {
  if (!env.OWNER_TOKEN_HASH) throw new AppError(503, '初期設定が必要です。セットアップ手順で所有者キーを作成してください。');
  const token = getToken(request);
  if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new AppError(401, '所有者キーでログインしてください。');
  const tokenHash = await digest(token);
  const found = await env.DB.prepare('SELECT token_hash FROM sessions WHERE token_hash = ? AND auth_version = ? AND expires_at > ?')
    .bind(tokenHash, env.OWNER_TOKEN_HASH, Date.now()).first();
  if (!found) throw new AppError(401, 'ログインの有効期限が切れています。');
  return tokenHash;
}

export async function limit(env: Env, key: string, maximum: number, windowMs: number, now = Date.now()) {
  const bucket = `${key}:${Math.floor(now / windowMs)}`;
  const result = await env.DB.prepare(`INSERT INTO rate_limits(key, count, expires_at) VALUES (?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET count = count + 1 WHERE count < ? RETURNING count`)
    .bind(bucket, now + windowMs * 2, maximum).first();
  if (!result) throw new AppError(429, '実行回数の上限です。少し待ってから試してください。');
}

export async function login(request: Request, env: Env) {
  if (!env.OWNER_TOKEN_HASH || !/^[a-f0-9]{64}$/.test(env.OWNER_TOKEN_HASH)) {
    throw new AppError(503, '初期設定が必要です。セットアップ手順を確認してください。');
  }
  const { token } = await readJson(request);
  if (typeof token !== 'string' || token.length < 32 || token.length > 256 || await digest(token) !== env.OWNER_TOKEN_HASH) {
    // Invalid guesses cannot spend the valid owner's session allowance.
    // Rate limiting follows bounded parsing/hash work and writes per-IP first.
    const ip = await digest(request.headers.get('CF-Connecting-IP') || 'local');
    await limit(env, `login:${ip}`, 10, 15 * 60_000);
    await limit(env, 'invalid-login-all', 60, 60 * 60_000);
    throw new AppError(401, '所有者キーが一致しません。');
  }
  await limit(env, 'owner-session', 30, 60 * 60_000);
  const session = randomToken();
  await env.DB.prepare('INSERT INTO sessions(token_hash, auth_version, expires_at) VALUES (?, ?, ?)')
    .bind(await digest(session), env.OWNER_TOKEN_HASH, Date.now() + 30 * 86400_000).run();
  return session;
}
