import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
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
  assert.equal((await fetch(base + '/api/research')).status, 401);
  const loginResearch = await req('/api/session', { token });
  const researchCookie = loginResearch.headers.get('Set-Cookie').split(';')[0];
  const getResearch = () => fetch(base + '/api/research', { headers: { Cookie: researchCookie } });
  assert.equal((await (await getResearch()).json()).state, 'unavailable');
  const current = new Date();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(current);
  const yesterday = new Date(Date.parse(today+'T00:00:00Z') - 86400_000).toISOString().slice(0,10);
  const future = new Date(Date.parse(today+'T00:00:00Z') + 14*86400_000).toISOString().slice(0,10);
  const fixture = { version:'close-indicators-v1', calendar:{ dates:[yesterday,today],through:future }, snapshots:['SOXL','TQQQ'].map(symbol=>({ symbol,asOf:yesterday,start:yesterday,retrievedAt:current.toISOString(),count:1,feed:'sip',adjustment:'split',metrics:{sma20:null,sma50:null,sma200:null,rsi14:null,return20Pct:null,drawdown63Pct:null},closes:[{date:yesterday,close:100}] })),latestBars:[] };
  const payloadSql = JSON.stringify(fixture).replaceAll("'", "''");
  cli(['d1','execute','DB','--local','--command',`INSERT INTO market_history VALUES ('sip','${current.toISOString()}','${yesterday}','fixture-hash','${payloadSql}'); INSERT INTO runs VALUES ('history-success','success','${current.toISOString()}','fixture');`]);
  const research = await (await getResearch()).json();
  assert.equal(research.state,'available');assert.equal(research.snapshots.length,2);
  assert.equal(research.snapshots[0].metrics.sma200,null);
  // A slower, older refresh cannot replace the current coherent window.
  cli(['d1','execute','DB','--local','--command',`INSERT INTO market_history VALUES ('sip','2000-01-01','2000-01-01','old','{}') ON CONFLICT(feed) DO UPDATE SET payload=excluded.payload,requested_at=excluded.requested_at WHERE excluded.requested_at>=market_history.requested_at;`]);
  assert.equal((await (await getResearch()).json()).inputHash,'fixture-hash');
  // Publish a staged complete pair through the real Worker/D1 transaction.
  const jobId = '12345678-1234-1234-1234-123456789abc';
  const jobStart = new Date();
  const quote = value => JSON.stringify(value).replaceAll("'", "''");
  const parts = fixture.snapshots.map(snapshot=>({snapshot,latestBar:{symbol:snapshot.symbol,timestamp:yesterday+'T04:00:00Z',close:100,volume:100,feed:'sip'}}));
  cli(['d1','execute','DB','--local','--command',`INSERT INTO market_collection_jobs(id,state,feed,requested_at,ny_date,expires_at,updated_at,calendar_payload,soxl_payload,tqqq_payload) VALUES ('${jobId}','ready','sip','${jobStart.toISOString()}','${today}','${new Date(jobStart.getTime()+1800000).toISOString()}','${jobStart.toISOString()}','${quote({...fixture.calendar,today})}','${quote(parts[0])}','${quote(parts[1])}');`]);
  assert.equal((await req('/api/check',{stage:'publish',jobId},researchCookie)).status,200);
  assert.equal((await req('/api/check',{stage:'publish',jobId},researchCookie)).status,409);
  const published = await (await getResearch()).json();
  assert.equal(published.collectionId,jobId);
  assert.equal(published.latestBars.length,2);
  assert.equal(published.state,'available');
  // News metadata is owner-only; unavailable/failed sources never imply no risk.
  assert.equal((await fetch(base+'/api/news')).status,401);
  const getNews=()=>fetch(base+'/api/news',{headers:{Cookie:researchCookie}});
  const emptyNews=await(await getNews()).json();assert.equal(emptyNews.sources.length,3);assert.equal(emptyNews.articles.length,0);
  assert.ok(emptyNews.sources.every(s=>s.state==='unavailable'));
  assert.equal((await getNews()).headers.get('cache-control'),'no-store');
  assert.equal((await req('/api/news/refresh',{source:'https://evil.example'},researchCookie)).status,400);
  assert.equal((await req('/api/news/refresh',{source:'alpaca'},researchCookie)).status,502);
  assert.equal((await(await getNews()).json()).sources.find(s=>s.source==='alpaca').state,'failed');
  assert.equal((await fetch(base+'/api/news/refresh',{method:'POST',headers:{Origin:'https://other.example','Content-Type':'application/json',Cookie:researchCookie},body:JSON.stringify({source:'fed'})})).status,403);
  const newsTime=new Date().toISOString();
  const newsEvidence={version:'news-evidence-v1',targets:['SOXL','TQQQ'],reasons:['NVDAのニュースタグ（架空テスト）'],topics:['業績・見通し'],reviewRequired:true,sourceKind:'reporting',verification:'source-only',direction:'unknown'};
  const newsPayload=JSON.stringify(newsEvidence).replaceAll("'","''");
  cli(['d1','execute','DB','--local','--command',`INSERT INTO news_items VALUES ('news-fixture','alpaca','https://www.benzinga.com/news/fixture','Fixture: company denies outlook rumor','${newsTime}',NULL,'${newsTime}','${newsTime}','${newsTime}','fixture-hash','fixture headline','${newsPayload}'); INSERT INTO news_revisions VALUES ('news-fixture','fixture-hash','${newsTime}','Fixture: company denies outlook rumor','${newsTime}',NULL,'${newsPayload}','["NVDA"]');`]);
  const sampleNews=await(await getNews()).json();assert.equal(sampleNews.articles.length,1);assert.equal(sampleNews.articles[0].evidence.direction,'unknown');assert.equal(sampleNews.articles[0].sourceState,'failed');assert.equal(sampleNews.articles[0].revisionSeen,newsTime);
  let extraNewsSQL='';
  for(let i=0;i<8;i++){
    const title=i<6?`Nvidia cuts quarterly guidance ${i}`:`Nvidia introduces game ${i}`;
    extraNewsSQL+=`INSERT INTO news_items VALUES ('priority-${i}','alpaca','https://www.benzinga.com/news/priority-${i}','${title}','${newsTime}',NULL,'${newsTime}','${newsTime}','${newsTime}','priority-hash-${i}','priority-${i}','${newsPayload}'); INSERT INTO news_revisions VALUES ('priority-${i}','priority-hash-${i}','${newsTime}','${title}','${newsTime}',NULL,'${newsPayload}','["NVDA"]');`;
  }
  cli(['d1','execute','DB','--local','--command',extraNewsSQL]);

  // Price hypotheses use the same authenticated, fresh history, and immutable observations.
  assert.equal((await fetch(base + '/api/price-rules')).status, 401);
  const ruleGet = () => fetch(base + '/api/price-rules', { headers: { Cookie: researchCookie } });
  assert.ok((await (await ruleGet()).json()).decisions.every(d => d.state === 'insufficient'));
  assert.equal((await req('/api/price-rules/observe', {}, researchCookie)).status, 409);
  const ruleDates = [];
  for (let d = new Date(yesterday); ruleDates.length < 230; d.setUTCDate(d.getUTCDate() - 1)) {
    if (![0, 6].includes(d.getUTCDay())) ruleDates.unshift(d.toISOString().slice(0, 10));
  }
  const ruleFixture = { ...fixture, calendar: { dates: [...ruleDates, today], through: future },
    snapshots: fixture.snapshots.map(s => ({ ...s, count: ruleDates.length, start: ruleDates[0], asOf: ruleDates.at(-1),
      closes: ruleDates.map((date, i) => ({ date, close: 100 + i * .2 + Math.sin(i * .4) * 4 })) })) };
  const setRuleFixture = () => cli(['d1','execute','DB','--local','--command',`UPDATE market_history SET payload='${quote(ruleFixture)}' WHERE feed='sip'`]);
  setRuleFixture();
  const rules = await (await ruleGet()).json();
  assert.equal(rules.state, 'available'); assert.equal(rules.decisions.length, 2);
  assert.equal((await ruleGet()).headers.get('cache-control'), 'no-store');
  const observationResponses = await Promise.all([req('/api/price-rules/observe', {}, researchCookie), req('/api/price-rules/observe', {}, researchCookie)]);
  const observationWrites = await Promise.all(observationResponses.map(r => { assert.equal(r.status, 200); return r.json(); }));
  assert.equal(observationWrites.filter(r => r.recorded).length, 1);
  assert.equal((await (await ruleGet()).json()).observations.length, 1);
  assert.equal((await fetch(base + '/api/price-rules/observe', { method: 'POST', headers: { Origin: 'https://other.example', 'Content-Type': 'application/json', Cookie: researchCookie }, body: '{}' })).status, 403);
  // Stale history is retained but not presented as current metrics.
  fixture.calendar.through='2000-01-01';
  cli(['d1','execute','DB','--local','--command',`UPDATE market_history SET payload='${JSON.stringify(fixture).replaceAll("'","''")}' WHERE feed='sip'`]);
  assert.equal((await (await getResearch()).json()).state,'stale');
  assert.deepEqual((await (await getResearch()).json()).snapshots,[]);
  const staleRules=await (await ruleGet()).json();
  assert.equal(staleRules.state,'stale');assert.deepEqual(staleRules.decisions,[]);assert.equal(staleRules.observations.length,1);
  // Portfolio checks use only this run's local D1 and fixture owner session.
  const privatePortfolio = await fetch(base + '/api/portfolio');
  assert.equal(privatePortfolio.status, 401);
  assert.equal(privatePortfolio.headers.get('Cache-Control'), 'no-store');
  assert.equal((await req('/api/portfolio')).status, 401);
  const getPortfolio = async () => {
    const response = await fetch(base + '/api/portfolio', { headers: { Cookie: researchCookie } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    return response.json();
  };
  const emptyPortfolio = await getPortfolio();
  assert.equal(emptyPortfolio.initialized, false);
  assert.equal(emptyPortfolio.revision, 0);
  const portfolioDate = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const initialize = {
    requestId: randomUUID(), revision: 0,
    change: { type: 'initialize', opening: { date: portfolioDate, cashJpy: '10000', cashUsd: '1000', holdings: [{ symbol: 'SOXL', quantity: '2', costUsd: '40' }] }, monthlyPlanJpy: '1234' },
  };
  const csrfPortfolio = await fetch(base + '/api/portfolio', {
    method: 'POST', headers: { Origin: 'https://other.example', 'Content-Type': 'application/json', Cookie: researchCookie }, body: JSON.stringify(initialize),
  });
  assert.equal(csrfPortfolio.status, 403);
  assert.equal(csrfPortfolio.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await getPortfolio(), emptyPortfolio);
  const writePortfolio = async (envelope, expectedStatus = 200) => {
    const response = await req('/api/portfolio', envelope, researchCookie);
    assert.equal(response.status, expectedStatus, `portfolio ${envelope.change.type}: expected ${expectedStatus}`);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    return response.json();
  };
  const initializedResponses = await Promise.all([writePortfolio(initialize), writePortfolio(initialize)]);
  for (const result of initializedResponses) { assert.equal(result.ok, true); assert.equal(result.revision, 1); }
  assert.equal(initializedResponses.filter(result => !result.replayed).length, 1);
  assert.equal((await writePortfolio(initialize)).replayed, true);
  const initializedPortfolio = await getPortfolio();
  assert.equal(initializedPortfolio.initialized, true);
  assert.equal(initializedPortfolio.revision, 1);
  assert.deepEqual(initializedPortfolio.cash, { JPY: '10000', USD: '1000.00' });
  assert.equal(initializedPortfolio.monthlyPlanJpy, '1234');
  assert.equal(initializedPortfolio.entries.length, 0);
  assert.equal(initializedPortfolio.positions.find(p => p.symbol === 'SOXL').costUsd, '40.00');
  await writePortfolio({ ...initialize, change: { ...initialize.change, monthlyPlanJpy: '9999' } }, 409);
  assert.deepEqual(await getPortfolio(), initializedPortfolio);
  const buy = {
    requestId: randomUUID(), revision: 1,
    change: { type: 'add', entry: { kind: 'buy', date: portfolioDate, symbol: 'SOXL', quantity: '2', grossUsd: '100', feeUsd: '1' } },
  };
  const boughtResponses = await Promise.all([writePortfolio(buy), writePortfolio(buy)]);
  for (const result of boughtResponses) { assert.equal(result.ok, true); assert.equal(result.revision, 2); }
  assert.equal(boughtResponses.filter(result => !result.replayed).length, 1);
  assert.equal((await writePortfolio(buy)).replayed, true);
  const boughtPortfolio = await getPortfolio();
  assert.equal(boughtPortfolio.revision, 2);
  assert.deepEqual(boughtPortfolio.cash, { JPY: '10000', USD: '899.00' });
  const soxl = boughtPortfolio.positions.find(p => p.symbol === 'SOXL');
  assert.equal(soxl.quantity, '4.000000');
  assert.equal(soxl.costUsd, '141.00');
  assert.equal(boughtPortfolio.entries.length, 1);
  assert.equal(boughtPortfolio.entries[0].id, buy.requestId);
  await writePortfolio({ ...buy, change: { ...buy.change, entry: { ...buy.change.entry, grossUsd: '101' } } }, 409);
  await writePortfolio({ requestId: randomUUID(), revision: 2, change: { type: 'add', entry: { ...buy.change.entry, grossUsd: '900' } } }, 400);
  await writePortfolio({ requestId: randomUUID(), revision: 2, change: { type: 'add', entry: { ...buy.change.entry, kind: 'sell', quantity: '5' } } }, 400);
  await writePortfolio({ requestId: randomUUID(), revision: 1, change: { type: 'plan', monthlyPlanJpy: '9999' } }, 409);
  assert.deepEqual(await getPortfolio(), boughtPortfolio);
  // Replaying an old receipt after later writes returns its original revision and does not roll back the ledger.
  const oldReceipt = await writePortfolio(initialize);
  assert.equal(oldReceipt.revision, 1);
  assert.equal(oldReceipt.replayed, true);
  assert.deepEqual(await getPortfolio(), boughtPortfolio);
  const receiptCount = JSON.parse(cli(['d1', 'execute', 'DB', '--local', '--command', 'SELECT COUNT(*) AS count FROM portfolio_requests', '--json']));
  assert.equal(receiptCount[0].results[0].count, 2);
  console.log('PASS: private no-store portfolio API, CSRF, initialization, parallel/exact replay, changed-ID conflict, cash/basis, overspend/oversell and stale revision');
  await fetch(base+'/api/logout',{method:'POST',headers:{Origin:base,'Content-Type':'application/json',Cookie:researchCookie},body:'{}'});
  assert.equal((await fetch(base + '/api/portfolio', { headers: { Cookie: researchCookie } })).status, 401);
  console.log('PASS: private history API, insufficient-history nulls, stale suppression and concurrent update guard');
  console.log('PASS: isolated Worker+D1 integration (owner auth, CSRF, secret isolation, missing data, endpoint validation, scheduled tests, concurrent daily cap, logout, PWA)');
  if (process.argv.includes('--browser')) {
    setRuleFixture();
    const evaluationFixture={version:'price-hypotheses-v1',rows:[{symbol:'SOXL',period:'後期',rule:'pullback',completed:3,meanPct:-2,medianPct:1,worstReturnPct:-12}]};
    cli(['d1','execute','DB','--local','--command',`INSERT INTO price_rule_evaluations VALUES ('price-hypotheses-v1','${current.toISOString()}','${quote(evaluationFixture)}')`]);
    // Reset ONLY portfolio tables in this disposable local fixture; keep all other integration state.
    // The singleton row must remain present so the browser exercises first-time registration.
    assert.ok(state.startsWith(dir + '/'));
    cli(['d1', 'execute', 'DB', '--local', '--command', 'DELETE FROM portfolio_requests; UPDATE portfolio_state SET revision=0,payload=NULL,last_request_id=NULL,updated_at=NULL WHERE id=1;']);
    const { chromium, expect } = await import('@playwright/test');
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
      await page.getByRole('heading', { name: 'ウォッチリスト' }).waitFor();
      assert.equal(await page.evaluate(()=>getComputedStyle(document.documentElement).colorScheme),'light');
      await expect(page.locator('#settings')).not.toHaveAttribute('open','');
      await expect(page.locator('#assets')).not.toHaveAttribute('open','');
      await page.locator('#settings > summary').click();
      assert.equal(await page.getByRole('button', { name: 'データ取得を確認' }).isEnabled(), false);
      assert.equal(await page.getByRole('button', { name: 'テスト通知を送る' }).count(), 0);
      assert.equal(await page.getByRole('button', { name: '通知を予約して閉じる' }).isEnabled(), false);
      assert.ok(await page.getByText('SOXL', { exact: true }).first().isVisible());
      assert.ok(await page.getByText('TQQQ', { exact: true }).first().isVisible());
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      const newsPanel=page.getByRole('region',{name:'ニュースと出所',exact:true});
      await expect(newsPanel.locator('.news-articles > li')).toHaveCount(5);
      await expect(newsPanel.locator('.news-articles > li').first()).toContainText('買い増し前に確認');
      await newsPanel.getByRole('button',{name:'参考記事も含めて表示（9件）'}).click();
      await expect(newsPanel.locator('.news-articles > li')).toHaveCount(9);
      await expect(newsPanel.getByRole('link',{name:'Fixture: company denies outlook rumor'})).toBeVisible();
      await newsPanel.getByText('取得状況・判定方法',{exact:true}).click();
      await newsPanel.getByText('情報源の取得状況（3件）',{exact:true}).click();
      await expect(newsPanel.getByText('取得失敗',{exact:true})).toBeVisible();
      await expect(newsPanel.getByText(/悪材料がない証拠ではなく/)).toBeVisible();
      await newsPanel.locator('.news-articles > li').first().getByText('根拠・詳細',{exact:true}).click();
      await expect(newsPanel.getByText(/優先した理由：/).first()).toBeVisible();
      const articleLink=newsPanel.getByRole('link',{name:'Fixture: company denies outlook rumor'});
      await expect(articleLink).toHaveAttribute('rel','noopener noreferrer');
      await newsPanel.getByLabel('ニュースの関連銘柄').selectOption('SOXL');
      await expect(articleLink).toBeVisible();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
      const rulePanel=page.getByRole('region',{name:'価格ルールの検証',exact:true});
      await expect(rulePanel).toHaveAttribute('aria-busy','false');
      await expect(rulePanel.locator('.entry-strategy').filter({has:page.getByRole('heading',{name:'SOXL',exact:true})})).toBeVisible();
      await expect(rulePanel.locator('.entry-strategy')).toHaveCount(2);
      await expect(rulePanel.getByText('20日高値更新の出口方針',{exact:true})).toHaveCount(2);
      await expect(rulePanel.locator('.entry-strategy').first()).toContainText('損切りなしを維持');
      await expect(rulePanel.locator('.entry-strategy').first()).toContainText('3年順位を代用せず保留');
      await rulePanel.getByText('旧モデルの観測・検証記録',{exact:true}).click();
      await expect(rulePanel.getByText('過去検証：20営業日後の値動き',{exact:true})).toBeVisible();
      await rulePanel.getByText('過去検証：20営業日後の値動き',{exact:true}).click();
      await expect(rulePanel.getByText('-2.00%',{exact:true})).toBeVisible();
      const observed=page.waitForResponse(r=>r.url().endsWith('/api/price-rules/observe'));
      await rulePanel.getByRole('button',{name:'現在の条件を観測に保存',exact:true}).click();
      assert.equal((await observed).status(),200);
      await expect(rulePanel).toHaveAttribute('aria-busy','false');
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
      await page.locator('#assets > summary').click();
      const portfolio = page.getByRole('region', { name: '資産台帳', exact: true });
      await expect(portfolio.getByRole('heading', { name: '開始時点を登録', exact: true })).toBeVisible();
      await expect(portfolio.getByLabel('開始日（JST）', { exact: true })).toHaveValue(portfolioDate);
      await expect(portfolio.getByLabel('毎月の入金予定（JPY・任意）', { exact: true })).toHaveValue('0');
      const browserPortfolio = async () => {
        const response = await context.request.get(base + '/api/portfolio');
        assert.equal(response.status(), 200);
        assert.equal(response.headers()['cache-control'], 'no-store');
        return response.json();
      };
      // Install response listeners before clicking; wait for both the write and mandatory reload.
      const savePortfolio = async (button, expectedStatus = 200) => {
        const posted = page.waitForResponse(r => new URL(r.url()).pathname === '/api/portfolio' && r.request().method() === 'POST');
        const reloaded = expectedStatus === 200
          ? page.waitForResponse(r => new URL(r.url()).pathname === '/api/portfolio' && r.request().method() === 'GET') : null;
        await button.click();
        const response = await posted;
        assert.equal(response.status(), expectedStatus, 'browser portfolio write');
        if (reloaded) assert.equal((await reloaded).status(), 200);
        await expect(portfolio).toHaveAttribute('aria-busy', 'false');
        if (expectedStatus === 200) await expect(portfolio.getByRole('alert')).toHaveCount(0);
        return response.request().postDataJSON();
      };
      const cash = currency => portfolio.locator('.portfolio-balances > div').filter({ has: page.getByText(`現金 · ${currency}`, { exact: true }) }).locator('strong');
      const position = symbol => portfolio.locator('.portfolio-positions article').filter({ has: page.getByRole('heading', { name: symbol, exact: true }) });
      const metric = (symbol, label) => position(symbol).locator('dl > div').filter({ has: page.getByText(label, { exact: true }) }).locator('dd');
      const inputTab = () => portfolio.getByRole('button', { name: '取引入力', exact: true }).click();
      const historyTab = () => portfolio.getByRole('button', { name: '履歴', exact: true }).click();
      const settingsTab = () => portfolio.getByRole('button', { name: '設定・JSON書き出し', exact: true }).click();
      await portfolio.getByLabel('円現金（JPY）', { exact: true }).fill('10000');
      await portfolio.getByLabel('米ドル現金（USD）', { exact: true }).fill('1000');
      await portfolio.getByText('既存の保有株（任意）', { exact: true }).click();
      await portfolio.getByLabel('SOXL 数量', { exact: true }).fill('2');
      await portfolio.locator('.portfolio-holding').filter({ has: page.getByRole('heading', { name: 'SOXL', exact: true }) }).getByLabel('取得総額（手数料込み・USD）', { exact: true }).fill('40');
      await savePortfolio(portfolio.getByRole('button', { name: '開始時点を保存', exact: true }));
      await expect(cash('JPY')).toHaveText('10000');
      await expect(cash('USD')).toHaveText('1000.00');
      await expect(metric('SOXL', '数量')).toHaveText('2.000000 株');
      await expect(metric('SOXL', '平均取得単価')).toHaveText('20.0000 USD');
      let ledger = await browserPortfolio();
      assert.equal(ledger.monthlyPlanJpy, '0');
      assert.equal(ledger.opening.holdings.length, 1, 'zero-quantity TQQQ must be omitted');
      // Deposit followed by a fee-inclusive buy; same-day ordering must remain stable.
      await portfolio.getByLabel('金額（JPY）', { exact: true }).fill('500');
      await portfolio.getByLabel('メモ（任意）', { exact: true }).fill('browser-deposit-private');
      await savePortfolio(portfolio.getByRole('button', { name: '取引を保存', exact: true }));
      await expect(cash('JPY')).toHaveText('10500');
      await portfolio.getByLabel('取引の種類', { exact: true }).selectOption('buy');
      await portfolio.getByLabel('数量（株）', { exact: true }).fill('2');
      await portfolio.getByLabel('約定総額（手数料を除く・USD）', { exact: true }).fill('100');
      await portfolio.getByLabel('手数料（USD）', { exact: true }).fill('1');
      await portfolio.getByLabel('メモ（任意）', { exact: true }).fill('browser-buy-private');
      await savePortfolio(portfolio.getByRole('button', { name: '取引を保存', exact: true }));
      await expect(cash('USD')).toHaveText('899.00');
      await expect(metric('SOXL', '数量')).toHaveText('4.000000 株');
      await expect(metric('SOXL', '取得総額')).toHaveText('141.00 USD');
      ledger = await browserPortfolio();
      const buyId = ledger.entries.find(e => e.kind === 'buy').id;
      // A validation failure exposes the safe domain message and retains editable input.
      await portfolio.getByLabel('取引の種類', { exact: true }).selectOption('sell');
      await portfolio.getByLabel('数量（株）', { exact: true }).fill('999');
      await portfolio.getByLabel('約定総額（手数料を除く・USD）', { exact: true }).fill('100');
      await savePortfolio(portfolio.getByRole('button', { name: '取引を保存', exact: true }), 400);
      await expect(portfolio.getByRole('alert')).toHaveText('売却数量が保有数量を超えています。');
      await expect(portfolio.getByLabel('数量（株）', { exact: true })).toHaveValue('999');
      assert.deepEqual(await browserPortfolio(), ledger);
      await historyTab();
      const buyRow = portfolio.locator('.portfolio-history > li').filter({ hasText: 'browser-buy-private' });
      await buyRow.getByRole('button', { name: '訂正', exact: true }).click();
      await portfolio.getByLabel('約定総額（手数料を除く・USD）', { exact: true }).fill('90');
      const edited = await savePortfolio(portfolio.getByRole('button', { name: '訂正を保存', exact: true }));
      assert.equal(edited.change.id, buyId);
      await expect(cash('USD')).toHaveText('909.00');
      await expect(metric('SOXL', '取得総額')).toHaveText('131.00 USD');
      ledger = await browserPortfolio();
      assert.equal(ledger.entries.length, 2);
      assert.equal(ledger.entries[1].id, buyId);
      await historyTab();
      await buyRow.getByRole('button', { name: '取消', exact: true }).click();
      await savePortfolio(buyRow.getByRole('button', { name: 'この取引の取消を確定', exact: true }));
      await expect(buyRow.getByText('取消済み', { exact: true })).toBeVisible();
      await expect(cash('USD')).toHaveText('1000.00');
      await expect(metric('SOXL', '数量')).toHaveText('2.000000 株');
      await expect(metric('SOXL', '取得総額')).toHaveText('40.00 USD');
      await savePortfolio(buyRow.getByRole('button', { name: '復元', exact: true }));
      await expect(buyRow.getByText('取消済み', { exact: true })).toHaveCount(0);
      await expect(cash('USD')).toHaveText('909.00');
      assert.equal((await browserPortfolio()).entries.find(e => e.id === buyId).voided, false);
      // Exercise the remaining ledger forms with deterministic cash and basis expectations.
      await inputTab();
      await portfolio.getByLabel('取引の種類', { exact: true }).selectOption('withdraw');
      await portfolio.getByLabel('金額（JPY）', { exact: true }).fill('100');
      await savePortfolio(portfolio.getByRole('button', { name: '取引を保存', exact: true }));
      await expect(cash('JPY')).toHaveText('10400');
      await portfolio.getByLabel('取引の種類', { exact: true }).selectOption('fx');
      await portfolio.getByLabel('実際の支払額（手数料込み・JPY）', { exact: true }).fill('1400');
      await portfolio.getByLabel('実際の受取額（手数料差引後・USD）', { exact: true }).fill('10');
      await savePortfolio(portfolio.getByRole('button', { name: '取引を保存', exact: true }));
      await expect(cash('JPY')).toHaveText('9000');
      await expect(cash('USD')).toHaveText('919.00');
      await portfolio.getByLabel('取引の種類', { exact: true }).selectOption('sell');
      await portfolio.getByLabel('数量（株）', { exact: true }).fill('1');
      await portfolio.getByLabel('約定総額（手数料を除く・USD）', { exact: true }).fill('50');
      await portfolio.getByLabel('手数料（USD）', { exact: true }).fill('1');
      await savePortfolio(portfolio.getByRole('button', { name: '取引を保存', exact: true }));
      await expect(cash('USD')).toHaveText('968.00');
      await expect(metric('SOXL', '実現損益（開始以降）')).toHaveText('16.25 USD');
      await portfolio.getByLabel('取引の種類', { exact: true }).selectOption('split');
      await portfolio.getByLabel('分割後の株数（分子）', { exact: true }).fill('2');
      await portfolio.getByLabel('分割前の株数（分母）', { exact: true }).fill('1');
      await savePortfolio(portfolio.getByRole('button', { name: '取引を保存', exact: true }));
      await expect(metric('SOXL', '数量')).toHaveText('6.000000 株');
      await expect(metric('SOXL', '取得総額')).toHaveText('98.25 USD');
      await settingsTab();
      await portfolio.getByLabel('毎月の入金予定（JPY）', { exact: true }).fill('1234');
      await savePortfolio(portfolio.getByRole('button', { name: '予定額を保存', exact: true }));
      await expect(cash('JPY')).toHaveText('9000');
      await portfolio.getByText('開始時点を訂正', { exact: true }).click();
      await portfolio.getByLabel('円現金（JPY）', { exact: true }).fill('12000');
      await savePortfolio(portfolio.getByRole('button', { name: '開始時点の訂正を保存', exact: true }));
      await expect(cash('JPY')).toHaveText('11000');
      ledger = await browserPortfolio();
      assert.equal(ledger.monthlyPlanJpy, '1234');
      assert.equal(ledger.entries.length, 6);
      assert.equal(ledger.entries[1].id, buyId);
      const downloadEvent = page.waitForEvent('download');
      await portfolio.getByRole('button', { name: 'JSONを書き出す', exact: true }).click();
      const download = await downloadEvent;
      assert.match(download.suggestedFilename(), /^portfolio-private-\d{4}-\d{2}-\d{2}\.json$/);
      const stream = await download.createReadStream();
      assert.ok(stream);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      assert.deepEqual(JSON.parse(Buffer.concat(chunks).toString('utf8')), ledger);
      await download.delete();
      await expect(portfolio).toHaveAttribute('aria-busy', 'false');
      // Commit succeeds but its response is lost: UI must retry the identical envelope.
      let lostResponse = false;
      const retriedBodies = [];
      await page.route('**/api/portfolio', async route => {
        if (route.request().method() !== 'POST') return route.continue();
        retriedBodies.push(route.request().postData());
        if (!lostResponse) {
          lostResponse = true;
          const result = await route.fetch();
          assert.equal(result.status(), 200);
          return route.abort('failed');
        }
        return route.continue();
      });
      await portfolio.getByLabel('毎月の入金予定（JPY）', { exact: true }).fill('1234');
      await portfolio.getByRole('button', { name: '予定額を保存', exact: true }).click();
      await expect(portfolio.getByRole('alert')).toContainText('保存結果を確認できません');
      await expect(portfolio.getByRole('button', { name: '予定額を保存', exact: true })).toBeDisabled();
      await savePortfolio(portfolio.getByRole('button', { name: '同じリクエストで保存を再試行', exact: true }));
      assert.equal(retriedBodies.length, 2);
      assert.equal(retriedBodies[0], retriedBodies[1]);
      await page.unroute('**/api/portfolio');
      const reconciled = await browserPortfolio();
      assert.deepEqual(reconciled, { ...ledger, revision: ledger.revision + 1 });
      ledger = reconciled;
      // An unsaved form draft must stay in memory only.
      await inputTab();
      await portfolio.getByLabel('メモ（任意）', { exact: true }).fill('unsaved-private-portfolio-draft');
      const assertNoPrivateStorage = async () => {
        assert.deepEqual(await page.evaluate(async () => ({
          local: Object.keys(localStorage), session: Object.keys(sessionStorage),
          databases: (await indexedDB.databases()).map(db => db.name), cacheNames: await caches.keys(),
        })), { local: [], session: [], databases: [], cacheNames: [] });
      };
      await assertNoPrivateStorage();
      // All stages, including expanded settings, must fit narrow Android and desktop widths.
      for (const width of [320, 390, 768, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        for (const name of ['取引入力', '履歴', '設定・JSON書き出し']) {
          await portfolio.getByRole('button', { name, exact: true }).click();
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, `portfolio ${name} overflow at ${width}px`);
          await expect(portfolio.getByRole('heading', { name: '資産台帳', exact: true })).toBeVisible();
        }
      }
      await historyTab();
      await page.setViewportSize({ width: 390, height: 844 });
      await assertNoPrivateStorage();

      mkdirSync(resolve(root, 'private'), { recursive: true });
      await page.screenshot({ path: resolve(root, 'private/validation-mobile.png'), fullPage: true });
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.screenshot({ path: resolve(root, 'private/validation-desktop.png'), fullPage: true });
      await page.getByRole('button', { name: 'ログアウト', exact: true }).click();
      await page.getByLabel('所有者キー', { exact: true }).waitFor();
      assert.equal(await page.getByRole('heading', { name: 'マーケットデータ' }).count(), 0);
      await expect(portfolio).toHaveCount(0);
      assert.equal((await context.request.get(base + '/api/portfolio')).status(), 401);
      await assertNoPrivateStorage();
      await page.reload();
      await page.getByLabel('所有者キー', { exact: true }).waitFor();
      await expect(portfolio).toHaveCount(0);
      await assertNoPrivateStorage();
      // Re-authentication loads the server ledger but never revives the unsaved draft.
      await page.getByLabel('所有者キー', { exact: true }).fill(token);
      await page.getByRole('button', { name: '安全に接続する' }).click();
      await page.locator('#assets > summary').click();
      await expect(cash('JPY')).toHaveText('11000');
      await expect(cash('USD')).toHaveText('968.00');
      await expect(portfolio.getByLabel('メモ（任意）', { exact: true })).toHaveValue('');
      assert.deepEqual(await browserPortfolio(), ledger);
      await assertNoPrivateStorage();
      await page.getByRole('button', { name: 'ログアウト', exact: true }).click();
      await page.getByLabel('所有者キー', { exact: true }).waitFor();
      await expect(portfolio).toHaveCount(0);
      assert.deepEqual(errors, []);
      console.log('PASS: Chrome portfolio registration, deposit/withdraw/FX/buy/sell/split, edit/void/restore, validation retention, plan/opening correction, JSON export, 320–1280px layouts, no private browser storage, logout/relogin; Android push remains unverified.');
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
