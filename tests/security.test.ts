import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { digest, readJson, requireSameOrigin, sessionCookie } from '../src/server/auth.ts';
import { jstDay, validateSubscription, verifySubscriptionKey } from '../src/server/push.ts';

test('クロスサイトの設定変更とログインを拒否', () => {
  for (const origin of [undefined, 'https://attacker.example']) {
    const req = new Request('https://app.example/api/session', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) } });
    assert.throws(() => requireSameOrigin(req));
  }
  assert.doesNotThrow(() => requireSameOrigin(new Request('https://app.example/api/session', {
    method: 'POST', headers: { Origin: 'https://app.example', 'Content-Type': 'application/json' },
  })));
});
test('所有者セッションはHttpOnly・Secure・SameSite、トークン自体はDBに保存しない', async () => {
  const req = new Request('https://app.example/');
  const cookie = sessionCookie(req, 'fixture');
  assert.match(cookie, /^__Host-/);
  for (const flag of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Path=/']) assert.ok(cookie.includes(flag));
  assert.equal((await digest('fixture')).length, 64);
  assert.match(sessionCookie(req, '', 0), /Max-Age=0/);
});
test('Content-Lengthなしでも巨大JSONを拒否', async () => {
  await assert.rejects(readJson(new Request('https://app.example/', { method: 'POST', body: JSON.stringify({ token: 'a'.repeat(9000) }) })), /大きすぎ/);
  await assert.rejects(readJson(new Request('https://app.example/', { method: 'POST', body: '[]' })), /読み取れ/);
});
test('通知先に任意URLや偽のサービスドメインを登録できない', () => {
  const { publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const p256dh = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x!, 'base64url'), Buffer.from(jwk.y!, 'base64url')]).toString('base64url');
  const keys = { p256dh, auth: Buffer.alloc(16).toString('base64url') };
  assert.equal(validateSubscription({ endpoint: 'https://fcm.googleapis.com/fcm/send/fixture', keys }).keys.p256dh, p256dh);
  for (const endpoint of ['http://fcm.googleapis.com/test', 'https://localhost/test', 'https://fcm.googleapis.com.evil.example/test', 'https://fcm.googleapis.com:444/test', 'https://x@fcm.googleapis.com/test']) {
    assert.throws(() => validateSubscription({ endpoint, keys }));
  }
  assert.throws(() => validateSubscription({ endpoint: 'https://fcm.googleapis.com/test', keys: { p256dh: 'bad', auth: 'bad' } }));
});
test('通知上限の日付をJSTの午前0時で切り替える', () => {
  assert.equal(jstDay(new Date('2026-09-26T14:59:59Z')), '2026-09-26');
  assert.equal(jstDay(new Date('2026-09-26T15:00:00Z')), '2026-09-27');
});
test('形式だけ正しい無効なP-256公開鍵を保存前に拒否', async () => {
  const sub = validateSubscription({ endpoint: 'https://fcm.googleapis.com/test', keys: {
    p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString('base64url'),
    auth: Buffer.alloc(16).toString('base64url'),
  } });
  await assert.rejects(verifySubscriptionKey(sub), /公開鍵/);
});
