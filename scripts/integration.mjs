import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, generateKeyPairSync } from 'node:crypto';
import assert from 'node:assert/strict';
import { setTimeout as pause } from 'node:timers/promises';

const root = resolve(import.meta.dirname, '..');
mkdirSync(resolve(root, '.test-state'), { recursive: true });
const dir = mkdtempSync(resolve(root, '.test-state/run-'));
const config = JSON.parse(readFileSync(resolve(root, 'wrangler.jsonc'), 'utf8'));
config.main = resolve(root, config.main);
config.assets.directory = resolve(root, 'dist');
config.assets.run_worker_first.push('/__scheduled');
config.d1_databases[0].migrations_dir = resolve(root, 'migrations');
const file = resolve(dir, 'wrangler.json');
writeFileSync(file, JSON.stringify(config));
const token = 'fixture-owner-token-for-isolated-tests-only';
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const pub = publicKey.export({ format: 'jwk' });
const priv = privateKey.export({ format: 'jwk' });
const raw = Buffer.concat([Buffer.from([4]), Buffer.from(pub.x, 'base64url'), Buffer.from(pub.y, 'base64url')]).toString('base64url');
writeFileSync(resolve(dir, '.dev.vars'), [
  `OWNER_TOKEN_HASH=${createHash('sha256').update(token).digest('hex')}`,
  `VAPID_PUBLIC_KEY=${raw}`, `VAPID_PRIVATE_KEY=${priv.d}`, 'VAPID_SUBJECT=https://example.com',
  'ALPACA_API_KEY=', 'ALPACA_API_SECRET=',
].join('\n'));
const wrangler = resolve(root, 'node_modules/wrangler/bin/wrangler.js');
const state = resolve(dir, 'state');
const cliEnv = { ...process.env, WRANGLER_SEND_METRICS: 'false', CI: 'true', CLOUDFLARE_LOAD_DEV_VARS_FROM_DOT_ENV: 'false' };
function cli(args) {
  const result = spawnSync(process.execPath, [wrangler, ...args, '--config', file, '--persist-to', state], { cwd: dir, env: cliEnv, encoding: 'utf8' });
  if (result.status) throw new Error(result.stderr + result.stdout);
  return result.stdout;
}
let server;
let log = '';
try {
  cli(['d1', 'migrations', 'apply', 'DB', '--local']);
  // Isolated local runtime: no real account keys and no remote database.
  server = spawn(process.execPath, [wrangler, 'dev', '--config', file, '--persist-to', state, '--ip', '127.0.0.1', '--port', '8799', '--test-scheduled'], { cwd: dir, env: cliEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  server.stdout.on('data', d => log += d);
  server.stderr.on('data', d => log += d);
  const base = 'http://127.0.0.1:8799';
  let ready = false;
  for (let i = 0; i < 100; i++) {
    if (server.exitCode !== null) throw new Error(log);
    try { const r = await fetch(base + '/api/status'); if (r.status === 401) { ready = true; break; } } catch {}
    await pause(250);
  }
  assert.ok(ready, log);
  const req = (path, body = {}, cookie = '') => fetch(base + path, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', Cookie: cookie }, body: JSON.stringify(body) });
  const denied = await fetch(base + '/api/status');
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get('Cache-Control'), 'no-store');
  assert.equal((await req('/api/check')).status, 401);
  const crossSite = await fetch(base + '/api/session', { method: 'POST', headers: { Origin: 'https://other.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
  assert.equal(crossSite.status, 403);
  assert.equal((await req('/api/session', { token: 'not-the-owner-key-00000000000000000' })).status, 401);
  // Even exhausting invalid-login quotas must not lock out the real owner.
  for (let i = 0; i < 10; i++) await req('/api/session', { token: 'not-the-owner-key-00000000000000000' });
  assert.equal((await req('/api/session', { token: 'not-the-owner-key-00000000000000000' })).status, 429);
  const signedIn = await req('/api/session', { token });
  assert.equal(signedIn.status, 200);
  const cookie = signedIn.headers.get('Set-Cookie').split(';')[0];
  const status = await fetch(base + '/api/status', { headers: { Cookie: cookie } });
  const payload = await status.json();
  assert.equal(payload.phase, 'validation');
  assert.equal(payload.configured.alpaca, false);
  assert.equal(payload.configured.push, true);
  assert.deepEqual(payload.bars, []);
  assert.ok(!JSON.stringify(payload).includes(priv.d));
  const failedCheck = await req('/api/check', {}, cookie);
  assert.equal(failedCheck.status, 503);
  const after = await (await fetch(base + '/api/status', { headers: { Cookie: cookie } })).json();
  assert.equal(after.latestRun.status, 'failed');
  assert.deepEqual(after.bars, []);
  const rejected = await req('/api/push/subscribe', { endpoint: 'https://localhost/secrets', keys: { p256dh: raw, auth: Buffer.alloc(16).toString('base64url') } }, cookie);
  assert.equal(rejected.status, 400);
  assert.equal((await req('/api/push/test', {}, cookie)).status, 409);
  assert.equal((await req('/api/push/schedule', {}, cookie)).status, 409);
  const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/fixture-never-sent', keys: { p256dh: raw, auth: Buffer.alloc(16).toString('base64url') } };
  assert.equal((await req('/api/push/subscribe', subscription, cookie)).status, 200);
  assert.equal((await req('/api/push/schedule', {}, cookie)).status, 200);
  assert.equal((await req('/api/push/schedule', {}, cookie)).status, 429);
  const deleted = await fetch(base + '/api/push/subscribe', { method: 'DELETE', headers: { Origin: base, 'Content-Type': 'application/json', Cookie: cookie }, body: '{}' });
  assert.equal(deleted.status, 200);
  // Seed overdue jobs: scheduler must skip them without sending to a service.
  const old = new Date(Date.now() - 3600_000);
  cli(['d1', 'execute', 'DB', '--local', '--command', `INSERT INTO notification_jobs(id,due_at,status,created_at) VALUES ('overdue',${old.getTime()},'pending','${old.toISOString()}')`]);
  const scheduled = await fetch(base + '/__scheduled');
  assert.equal(scheduled.status, 200);
  const jobs = cli(['d1', 'execute', 'DB', '--local', '--command', "SELECT status FROM notification_jobs WHERE id='overdue'", '--json']);
  assert.ok(jobs.includes('skipped'));
  // Concurrent ticks must respect an already-reserved daily cap, without sends.
  const day = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  cli(['d1', 'execute', 'DB', '--local', '--command', `INSERT INTO daily_notifications(day,job_id) VALUES ('${day}','reserved'); INSERT INTO notification_jobs(id,due_at,status,created_at) VALUES ('a',${Date.now()-1000},'pending','${new Date().toISOString()}'),('b',${Date.now()-1000},'pending','${new Date().toISOString()}');`]);
  await Promise.all([fetch(base + '/__scheduled'), fetch(base + '/__scheduled')]);
  const capped = JSON.parse(cli(['d1', 'execute', 'DB', '--local', '--command', "SELECT COUNT(*) AS count FROM notification_jobs WHERE id IN ('a','b') AND status='skipped'", '--json']));
  assert.equal(capped[0].results[0].count, 2);
  assert.equal((await req('/api/logout', {}, cookie)).status, 200);
  assert.equal((await fetch(base + '/api/status', { headers: { Cookie: cookie } })).status, 401);
  const shell = await fetch(base + '/');
  assert.equal(shell.status, 200);
  const shellText = await shell.text();
  assert.ok(!shellText.includes(token));
  assert.ok(!shellText.includes(priv.d));
  const manifest = await fetch(base + '/manifest.webmanifest');
  assert.equal(manifest.status, 200);
  assert.equal((await manifest.json()).display, 'standalone');
  console.log('PASS: isolated Worker+D1 integration (owner auth, CSRF, secret isolation, missing data, endpoint validation, scheduled tests, concurrent daily cap, logout, PWA)');
  if (process.argv.includes('--browser')) {
    const { chromium } = await import('@playwright/test');
    const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    const browser = await chromium.launch({ headless: true, ...(existsSync(chrome) ? { executablePath: chrome } : {}) });
    try {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(base);
      await page.getByLabel('所有者キー', { exact: true }).fill(token);
      await page.getByRole('button', { name: '安全に接続する' }).click();
      await page.getByRole('heading', { name: 'マーケットデータ' }).waitFor();
      assert.equal(await page.getByRole('button', { name: 'データ取得を確認' }).isEnabled(), false);
      assert.equal(await page.getByRole('button', { name: 'テスト通知を送る' }).count(), 0);
      assert.equal(await page.getByRole('button', { name: '通知を予約して閉じる' }).isEnabled(), false);
      assert.ok(await page.getByText('SOXL', { exact: true }).isVisible());
      assert.ok(await page.getByText('TQQQ', { exact: true }).isVisible());
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      assert.equal(await page.evaluate(() => Object.keys(localStorage).length), 0);
      mkdirSync(resolve(root, 'private'), { recursive: true });
      await page.screenshot({ path: resolve(root, 'private/validation-mobile.png'), fullPage: true });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.screenshot({ path: resolve(root, 'private/validation-desktop.png'), fullPage: true });
      await page.getByRole('button', { name: 'ログアウト', exact: true }).click();
      await page.getByLabel('所有者キー', { exact: true }).waitFor();
      assert.equal(await page.getByRole('heading', { name: 'マーケットデータ' }).count(), 0);
      await page.reload();
      await page.getByLabel('所有者キー', { exact: true }).waitFor();
      assert.deepEqual(errors, []);
      console.log('PASS: Chrome mobile/desktop UI, login, missing-key controls, layout, logout and reload; Android push remains unverified.');
    } finally { await browser.close(); }
  }
} catch (error) {
  console.error(error.message);
  console.error(log.slice(-6000));
  process.exitCode = 1;
} finally {
  if (server && server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise(r => server.once('exit', r)), pause(3000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  rmSync(dir, { recursive: true, force: true });
}
