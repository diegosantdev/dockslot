import { migrate, pool } from './index.js';
import { seed } from './seed.js';
try {
  if (process.argv[2] === 'seed') console.log(await seed());
  else {
    await migrate();
    console.log('Migrations applied');
  }
} finally {
  await pool.end();
}
