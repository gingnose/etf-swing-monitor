import { AppError, type Env } from './types.ts';
import { login, limit, readJson, requireOwner, requireSameOrigin, sessionCookie } from './auth.ts';
import { readPriceRules, observePriceRules } from './price-rules.ts';
import { readPortfolio, writePortfolio } from './portfolio.ts';
import { readResearch, refreshCalendar } from './history.ts';
import { collectStart, collectContinue, collectPublish } from './collection.ts';
import { jstDay, processNotificationJobs, pushConfigured, sendTestPush, validateSubscription, verifySubscriptionKey } from './push.ts';

function json(value: unknown, status = 200, extra: Record<string, string> = {}) {
  return Response.json(value, { status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', ...extra } });
}

async function api(request: Request, env: Env) {
  const path = new URL(request.url).pathname;
  const method = request.method;
  if (!['GET', 'POST', 'DELETE'].includes(method)) throw new AppError(405, 'この操作には対応していません。');
  if (method !== 'GET') requireSameOrigin(request);
  if (path === '/api/session' && method === 'POST') {
    const token = await login(request, env);
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(request, token) });
  }
  const sessionHash = await requireOwner(request, env);
  if (path === '/api/logout' && method === 'POST') {
    await env.DB.prepare('DELETE FROM sessions WHERE token_hash=?').bind(sessionHash).run();
    return json({ ok: true }, 200, { 'Set-Cookie': sessionCookie(request, '', 0) });
  }
  if (path === '/api/portfolio' && method === 'GET') return json(await readPortfolio(env));
  if (path === '/api/portfolio' && method === 'POST') return json(await writePortfolio(env, await readJson(request)));
  if (path === '/api/price-rules' && method === 'GET') return json(await readPriceRules(env));
  if (path === '/api/price-rules/observe' && method === 'POST') {
    await limit(env,'price-observe',6,3600_000);
    return json(await observePriceRules(env));
  }
  if (path === '/api/research' && method === 'GET') return json(await readResearch(env));
  if (path === '/api/status' && method === 'GET') {
    const latestRun = await env.DB.prepare('SELECT status,created_at AS createdAt,detail FROM runs ORDER BY created_at DESC LIMIT 1')
      .first<{ status: string; createdAt: string; detail: string }>();
    const subscribed = await env.DB.prepare('SELECT id FROM push_subscription WHERE id=1').first();
    const latestNotification = await env.DB.prepare('SELECT status,detail,due_at AS dueAt FROM notification_jobs ORDER BY created_at DESC LIMIT 1').first();
    const research = await readResearch(env);
    return json({ phase: 'validation', research, configured: { alpaca: Boolean(env.ALPACA_API_KEY && env.ALPACA_API_SECRET), push: pushConfigured(env) },
      latestRun, bars: research.state === 'available' ? research.latestBars : [],
      dataState: research.state,
      push: { subscribed: Boolean(subscribed), publicKey: pushConfigured(env) ? env.VAPID_PUBLIC_KEY : null },
      notificationTime: '21:00 JST', latestNotification,
      scheduledChecksEnabled: env.ENABLE_SCHEDULED_CHECKS === 'true',
    });
  }
  if (path === '/api/calendar' && method === 'POST') {
    await limit(env, 'calendar-check', 3, 3600_000);
    return json(await refreshCalendar(env));
  }
  if (path === '/api/check' && method === 'POST') {
    const body = await readJson(request);
    if (!body.stage || body.stage === 'start') {
      await limit(env, 'market-check', 3, 3600_000);
      return json(await collectStart(env));
    }
    if (!['continue','publish'].includes(String(body.stage)) || typeof body.jobId !== 'string' || !/^[a-f0-9-]{36}$/.test(body.jobId)) throw new AppError(400,'更新処理の指定が不正です。');
    return json(body.stage === 'continue' ? await collectContinue(env, body.jobId) : await collectPublish(env, body.jobId));
  }
  if (path === '/api/push/subscribe' && method === 'POST') {
    if (!pushConfigured(env)) throw new AppError(503, '通知用の鍵が未設定です。');
    await limit(env, 'subscription', 20, 3600_000);
    const sub = validateSubscription(await readJson(request));
    await verifySubscriptionKey(sub);
    await env.DB.prepare(`INSERT INTO push_subscription(id,endpoint,p256dh,auth,updated_at) VALUES (1,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET endpoint=excluded.endpoint,p256dh=excluded.p256dh,auth=excluded.auth,updated_at=excluded.updated_at`)
      .bind(sub.endpoint, sub.keys.p256dh, sub.keys.auth, new Date().toISOString()).run();
    return json({ ok: true, detail: 'この端末を通知先に登録しました。' });
  }
  if (path === '/api/push/subscribe' && method === 'DELETE') {
    await env.DB.batch([env.DB.prepare('DELETE FROM push_subscription'),
      env.DB.prepare("UPDATE notification_jobs SET status='skipped',detail='通知登録を解除しました。' WHERE status='pending'")]);
    return json({ ok: true, detail: '通知登録を解除しました。' });
  }
  if (path === '/api/push/test' && method === 'POST') {
    await limit(env, 'manual-push-test', 5, 86400_000);
    return json(await sendTestPush(env, crypto.randomUUID()));
  }
  if (path === '/api/push/schedule' && method === 'POST') {
    if (!pushConfigured(env)) throw new AppError(503, '通知用の鍵が未設定です。');
    const subscribed = await env.DB.prepare('SELECT id FROM push_subscription WHERE id=1').first();
    if (!subscribed) throw new AppError(409, '先にこの端末の通知を有効にしてください。');
    const now = new Date();
    const sent = await env.DB.prepare('SELECT day FROM daily_notifications WHERE day=?').bind(jstDay(now)).first();
    if (sent) throw new AppError(409, '本日の自動通知枠は使用済みです。即時テストは手動で実行できます。');
    await limit(env, 'schedule-test', 1, 10 * 60_000);
    const added = await env.DB.prepare(`INSERT INTO notification_jobs(id,due_at,status,created_at)
      SELECT ?,?,'pending',? WHERE NOT EXISTS (SELECT id FROM notification_jobs WHERE status='pending')`)
      .bind(crypto.randomUUID(), now.getTime() + 5 * 60_000, now.toISOString()).run();
    if (!added.meta.changes) throw new AppError(409, 'すでに予約済みです。端末を閉じてお待ちください。');
    return json({ ok: true, detail: '約5〜10分後の通知を予約しました。クラウドへ公開済みなら、アプリとPCを閉じて確認できます。' });
  }
  throw new AppError(404, 'この操作は見つかりません。');
}

export async function scheduledRun(env: Env, now = new Date()) {
  if (!env.OWNER_TOKEN_HASH) return;
  // Keep push encryption and market acquisition in separate CPU budgets.
  if (await processNotificationJobs(env, now)) return;
  if (env.ENABLE_SCHEDULED_CHECKS === 'true' && now.getUTCMinutes() < 25 && [0, 6, 12].includes(now.getUTCHours())) {
    const stage = Math.floor(now.getUTCMinutes()/5);
    const hour = now.toISOString().slice(0,13);
    const slot = hour + ':' + stage;
    const reserved = await env.DB.prepare('INSERT OR IGNORE INTO scheduled_checks(slot,created_at) VALUES (?,?)').bind(slot, now.toISOString()).run();
    if (reserved.meta.changes === 1) {
      try {
        if (stage === 0) await refreshCalendar(env, now);
        else if (stage === 1) {
          const result = await collectStart(env, now);
          await env.DB.prepare('UPDATE scheduled_checks SET job_id=? WHERE slot=?').bind(result.jobId,slot).run();
        } else if (stage === 4) {
          await observePriceRules(env,now);
        } else {
          const job = await env.DB.prepare('SELECT job_id FROM scheduled_checks WHERE slot=?').bind(hour+':1').first<{job_id:string|null}>();
          if (job?.job_id) {
            if (stage===2) await collectContinue(env,job.job_id,now);
            else await collectPublish(env,job.job_id,now);
          }
        }
      } catch { /* Retain the last complete snapshot; collector records acquisition failures. */ }
    }
  }

  // Fixed-size operational history, avoiding unbounded free-tier storage growth.
  if (now.getUTCHours() === 3 && now.getUTCMinutes() < 5) {
    const historyCutoff = new Date(now.getTime() - 365 * 86400_000).toISOString();
    const cutoff = new Date(now.getTime() - 30 * 86400_000).toISOString();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM price_rule_observations WHERE observed_at < ?').bind(historyCutoff),
      env.DB.prepare('DELETE FROM market_collection_jobs WHERE expires_at < ?').bind(now.toISOString()),
      env.DB.prepare('DELETE FROM market_observations WHERE retrieved_at < ?').bind(historyCutoff),
      env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now.getTime()),
      env.DB.prepare('DELETE FROM rate_limits WHERE expires_at < ?').bind(now.getTime()),
      env.DB.prepare('DELETE FROM runs WHERE created_at < ?').bind(cutoff),
      env.DB.prepare('DELETE FROM bars WHERE timestamp < ?').bind(cutoff),
      env.DB.prepare('DELETE FROM scheduled_checks WHERE created_at < ?').bind(cutoff),
      env.DB.prepare('DELETE FROM notification_jobs WHERE created_at < ?').bind(cutoff),
      env.DB.prepare('DELETE FROM daily_notifications WHERE day < ?').bind(cutoff.slice(0, 10)),
    ]);
  }
}

export default {
  async fetch(request: Request, env: Env) {
    if (new URL(request.url).pathname.startsWith('/api/')) {
      try { return await api(request, env); }
      catch (error) {
        // Never return upstream bodies, credential values, or internal traces.
        return json({ ok: false, detail: error instanceof AppError ? error.message : '処理を完了できませんでした。設定とサービスの稼働状態を確認してください。' }, error instanceof AppError ? error.status : 503);
      }
    }
    return env.ASSETS.fetch(request);
  },
  async scheduled(_controller: ScheduledController, env: Env, _ctx: ExecutionContext) {
    await scheduledRun(env);
  },
} satisfies ExportedHandler<Env>;
