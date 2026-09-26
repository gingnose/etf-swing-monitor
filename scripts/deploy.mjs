import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
if (!existsSync(resolve(root, 'wrangler.deploy.jsonc'))) {
  console.error('先に docs/SETUP.md に従って無料アカウントとD1を設定してください。'); process.exit(1);
}
// Deployment never changes subscriptions or installs paid resources.
for (const args of [ ['run', 'build'], ['exec', '--', 'wrangler', 'd1', 'migrations', 'apply', 'DB', '--remote', '--config', 'wrangler.deploy.jsonc'], ['exec', '--', 'wrangler', 'deploy', '--config', 'wrangler.deploy.jsonc'] ]) {
  const result = spawnSync('npm', args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
