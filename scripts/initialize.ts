import { migrate, pool } from '@dockslot/db';
import { seed } from '../packages/db/src/seed.js';
try {
  await migrate();
  if (process.env.DEMO_MODE === 'true') console.log(await seed());
  else
    console.log(
      process.env.AUTH_MODE === 'session'
        ? 'Schema ready. Initialize the organization from the sign-in screen.'
        : 'Schema ready. Open DockSlot and create your first facility. No account required.',
    );
} finally {
  await pool.end();
}
