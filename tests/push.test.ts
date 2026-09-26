import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { sendTestPush } from '../src/server/push.ts';
import type { Env } from '../src/server/types.ts';

function keys() {
  const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const pub = pair.publicKey.export({ format: 'jwk' });
  const priv = pair.privateKey.export({ format: 'jwk' });
  return { publicKey: Buffer.concat([Buffer.from([4]), Buffer.from(pub.x!, 'base64url'), Buffer.from(pub.y!, 'base64url')]).toString('base64url'), privateKey: priv.d! };
}
test('Web Cryptoで暗号化し、通知サービスへVAPIDで送信（通信はテスト内で置換）', async () => {
  const vapid = keys();
  const receiver = keys();
  const endpoint = 'https://fcm.googleapis.com/fcm/send/isolated-fixture';
  const env = {
    VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: 'https://example.com',
    DB: { prepare: () => ({ first: async () => ({ endpoint, p256dh: receiver.publicKey, auth: Buffer.from(randomBytes(16)).toString('base64url') }) }) },
  } as unknown as Env;
  const original = globalThis.fetch;
  let count = 0;
  globalThis.fetch = (async (url, init) => {
    count++;
    assert.equal(url, endpoint);
    assert.equal(init?.redirect, 'error');
    const headers = new Headers(init?.headers);
    assert.match(headers.get('Authorization') || '', /^vapid /);
    assert.equal(headers.get('Content-Encoding'), 'aes128gcm');
    assert.equal(headers.get('TTL'), '600');
    assert.ok(init?.body);
    assert.ok(!JSON.stringify(init).includes(vapid.privateKey));
    return new Response('', { status: 201 });
  }) as typeof fetch;
  try {
    const result = await sendTestPush(env, 'fixture');
    assert.equal(count, 1);
    assert.match(result.detail, /到着は実機/);
  } finally { globalThis.fetch = original; }
});
