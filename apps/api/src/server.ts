import 'dotenv/config';
import { buildApp } from './app.js';
import { pool } from '@dockslot/db';
const app = await buildApp();
await app.listen({ port: Number(process.env.PORT || 4000), host: process.env.HOST || '127.0.0.1' });
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    await app.close();
    await pool.end();
    process.exit(0);
  });
