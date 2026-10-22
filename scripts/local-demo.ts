import { DevelopmentPostgres as EmbeddedPostgres } from './development-postgres.js';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
process.env.DATABASE_URL = 'postgres://dockslot:dockslot@127.0.0.1:55432/dockslot';
process.env.DEMO_MODE ||= 'true';
process.env.AUTH_MODE ||= 'local';
process.env.WEB_ORIGIN = 'http://localhost:3000';
process.env.API_INTERNAL_URL = 'http://localhost:4000';
const dir = resolve('.local/demo-postgres');
mkdirSync(resolve('.local'), { recursive: true });
const keyFile = resolve('.local/encryption-key');
if (!existsSync(keyFile)) writeFileSync(keyFile, randomBytes(32).toString('hex'), { mode: 0o600 });
process.env.ENCRYPTION_KEY ||= readFileSync(keyFile, 'utf8').trim();
const postgres = new EmbeddedPostgres({
  databaseDir: dir,
  user: 'dockslot',
  password: 'dockslot',
  port: 55432,
  persistent: true,
  initdbFlags: ['--encoding=UTF8', '--locale=C', '--no-sync'],
  postgresFlags: ['-h', '127.0.0.1'],
  onLog: (message) => console.log(String(message)),
  onError: (message) => console.error(String(message)),
});
if (!existsSync(resolve(dir, 'PG_VERSION'))) await postgres.initialise();
await postgres.start();
try {
  await postgres.createDatabase('dockslot');
} catch (e) {
  if (!(e as Error).message.includes('already exists')) throw e;
}
const { migrate, pool } = await import('../packages/db/src/index.js');
const { seed } = await import('../packages/db/src/seed.js');
const { buildApp } = await import('../apps/api/src/app.js');
const { tick } = await import('../apps/worker/src/main.js');
await migrate();
if (process.env.DEMO_MODE === 'true') console.log(await seed());
const app = await buildApp();
await app.listen({ port: 4000, host: '127.0.0.1' });
const web = spawn(
  process.execPath,
  [
    resolve('node_modules/next/dist/bin/next'),
    'dev',
    '--webpack',
    '-p',
    '3000',
    '--hostname',
    '127.0.0.1',
  ],
  {
    cwd: resolve('apps/web'),
    stdio: 'inherit',
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
  },
);
let workerBusy = false;
const timer = setInterval(async () => {
  if (workerBusy) return;
  workerBusy = true;
  try {
    await tick();
  } catch (e) {
    console.error((e as Error).message);
  } finally {
    workerBusy = false;
  }
}, 1000);
console.log('DockSlot local: http://localhost:3000 · API: http://localhost:4000/docs');
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  web.kill();
  await app.close();
  await pool.end();
  await postgres.stop();
  process.exit(0);
}
for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => void stop());
