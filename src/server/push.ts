import { buildPushPayload } from '@block65/webcrypto-web-push';
import { AppError, type Env } from './types.ts';

export type Subscription = { endpoint: string; expirationTime: null; keys: { p256dh: string; auth: string } };
export function validateSubscription(input: Record<string, unknown>): Subscription {
  if (typeof input.endpoint !== 'string' || input.endpoint.length > 2048) throw new AppError(400, '通知先が不正です。');
  let url: URL;
  try { url = new URL(input.endpoint); } catch { throw new AppError(400, '通知先が不正です。'); }
  // Prevent server-side requests to arbitrary destinations. Chrome/Edge/Firefox
  // on Android are supported; unsupported services fail closed, never redirected.
  const hosts = ['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'updates-autopush.stage.mozaws.net'];
  if (url.protocol !== 'https:' || url.port || url.username || url.password || url.hash || !hosts.includes(url.hostname)) {
    throw new AppError(400, 'この通知サービスには未対応です。AndroidのChromeで開いてください。');
  }
  const keys = input.keys as Record<string, unknown> | undefined;
  if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') throw new AppError(400, '通知用の鍵が不正です。');
  const decode = (s: string) => { try { return atob(s.replace(/-/g, '+').replace(/_/g, '/')); } catch { return ''; } };
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(keys.p256dh) || !/^[A-Za-z0-9_-]+={0,2}$/.test(keys.auth) ||
      decode(keys.p256dh).length !== 65 || decode(keys.p256dh).charCodeAt(0) !== 4 || decode(keys.auth).length !== 16) {
    throw new AppError(400, '通知用の鍵が不正です。');
  }
  return { endpoint: url.href, expirationTime: null, keys: { p256dh: keys.p256dh, auth: keys.auth } };
}

export async function verifySubscriptionKey(sub: Subscription) {
  try {
    const raw = Uint8Array.from(atob(sub.keys.p256dh.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    await crypto.subtle.importKey('raw', raw, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  } catch { throw new AppError(400, '通知用の公開鍵を検証できませんでした。再登録してください。'); }
}

export function pushConfigured(env: Env) {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT);
}

export async function sendTestPush(env: Env, tag: string) {
  if (!pushConfigured(env)) throw new AppError(503, '通知用の鍵が未設定です。');
  const row = await env.DB.prepare('SELECT endpoint,p256dh,auth FROM push_subscription WHERE id=1').first<{ endpoint: string; p256dh: string; auth: string }>();
  if (!row) throw new AppError(409, '先にこの端末の通知を有効にしてください。');
  const sub = validateSubscription({ endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } });
  try {
    const payload = await buildPushPayload({ data: JSON.stringify({ title: 'ETF Swing Monitor', body: '通知テストです。売買の提案ではありません。', url: '/', tag }), options: { ttl: 600 } }, sub, {
      publicKey: env.VAPID_PUBLIC_KEY!, privateKey: env.VAPID_PRIVATE_KEY!, subject: env.VAPID_SUBJECT!,
    });
    const response = await fetch(sub.endpoint, { ...payload, redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if ([404, 410].includes(response.status)) {
      await env.DB.prepare('DELETE FROM push_subscription WHERE id=1 AND endpoint=?').bind(sub.endpoint).run();
      throw new AppError(409, '通知登録の有効期限が切れました。再登録してください。');
    }
    if (!response.ok) throw new AppError(502, `通知サービスが受け付けませんでした（HTTP ${response.status}）。`);
    return { ok: true, detail: '通知サービスが送信を受け付けました。端末への到着は実機で確認してください。' };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(502, '通知の送信結果を確認できません。重複を避けるため自動再送しません。');
  }
}

export function jstDay(now: Date) { return new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10); }

export async function processNotificationJobs(env: Env, now = new Date()) {
  const jobs = await env.DB.prepare(`UPDATE notification_jobs SET status='claimed'
    WHERE id IN (SELECT id FROM notification_jobs WHERE status='pending' AND due_at<=? LIMIT 1)
    RETURNING id,due_at`).bind(now.getTime()).all<{ id: string; due_at: number }>();
  for (const job of jobs.results) {
    if (now.getTime() - job.due_at > 30 * 60_000) {
      await env.DB.prepare("UPDATE notification_jobs SET status='skipped',detail=? WHERE id=?").bind('予約から時間が経過したため送信しませんでした。', job.id).run();
      continue;
    }
    // Atomic reservation before any external side effect. Never release on an
    // ambiguous send result: avoiding duplicates wins over automatic retries.
    const reserved = await env.DB.prepare('INSERT OR IGNORE INTO daily_notifications(day,job_id) VALUES (?,?)')
      .bind(jstDay(now), job.id).run();
    let state = 'skipped';
    let detail = '本日の自動通知はすでに送信済みです。';
    if (reserved.meta.changes === 1) {
      try { detail = (await sendTestPush(env, job.id)).detail; state = 'accepted'; }
      catch (error) { state = 'failed'; detail = error instanceof AppError ? error.message : '通知に失敗しました。'; }
    }
    await env.DB.prepare('UPDATE notification_jobs SET status=?,detail=? WHERE id=?').bind(state, detail, job.id).run();
  }
}
