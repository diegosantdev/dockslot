import 'dotenv/config';
import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { sameSlot, type Snapshot, type Allocation } from '@dockslot/domain';
export const pool = new pg.Pool({
  connectionString:
    process.env.DATABASE_URL || 'postgres://dockslot:dockslot@localhost:5432/dockslot',
  max: 20,
});
export type Client = pg.PoolClient;
export const uid = (prefix: string) => `${prefix}_${randomUUID()}`;
export async function transaction<T>(fn: (c: Client) => Promise<T>, db = pool): Promise<T> {
  const c = await db.connect();
  try {
    await c.query('BEGIN');
    const value = await fn(c);
    await c.query('COMMIT');
    return value;
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
  }
}
export async function migrate(db = pool) {
  await transaction(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(859341)');
    await c.query(
      'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())',
    );
    const dir = fileURLToPath(new URL('../migrations/', import.meta.url));
    for (const name of (await readdir(dir)).filter((n) => n.endsWith('.sql')).sort()) {
      if ((await c.query('SELECT 1 FROM schema_migrations WHERE name=$1', [name])).rowCount)
        continue;
      await c.query(await readFile(`${dir}/${name}`, 'utf8'));
      await c.query('INSERT INTO schema_migrations(name) VALUES($1)', [name]);
    }
  }, db);
}
export async function snapshot(
  c: Client,
  siteId: string,
  organizationId: string,
  lock = false,
): Promise<Snapshot | null> {
  const siteRow = (
    await c.query(
      `SELECT * FROM sites WHERE id=$1 AND organization_id=$2 ${lock ? 'FOR UPDATE' : ''}`,
      [siteId, organizationId],
    )
  ).rows[0];
  if (!siteRow) return null;
  const docks = (
    await c.query('SELECT data FROM docks WHERE site_id=$1 ORDER BY id', [siteId])
  ).rows.map((r) => r.data);
  const appointments = (
    await c.query(
      'SELECT data FROM appointments WHERE site_id=$1 AND organization_id=$2 ORDER BY id',
      [siteId, organizationId],
    )
  ).rows.map((r) => r.data);
  const visits = (
    await c.query(
      'SELECT v.data FROM visits v JOIN appointments a ON a.id=v.appointment_id WHERE a.site_id=$1',
      [siteId],
    )
  ).rows.map((r) => r.data);
  const blocks = (
    await c.query('SELECT data FROM dock_blocks WHERE site_id=$1 ORDER BY id', [siteId])
  ).rows.map((r) => r.data);
  const allocations: Allocation[] = (
    await c.query(
      "SELECT * FROM dock_allocations WHERE site_id=$1 AND state='active' ORDER BY id",
      [siteId],
    )
  ).rows.map((r) => ({
    id: r.id,
    appointmentId: r.appointment_id,
    dockId: r.dock_id,
    startAt: r.start_at.toISOString(),
    endAt: r.end_at.toISOString(),
    planVersion: r.plan_version,
  }));
  return {
    site: { ...siteRow.data, currentPlanVersion: siteRow.current_plan_version },
    docks,
    appointments,
    visits,
    blocks,
    allocations,
  };
}
/** Caller holds the site row lock. Active allocations are replaced before insert, atomically. */
export async function persist(c: Client, before: Snapshot, after: Snapshot, actor: string) {
  const version = before.site.currentPlanVersion + 1,
    siteId = after.site.id;
  after.site.currentPlanVersion = version;
  await c.query(
    'UPDATE sites SET data=$2, current_plan_version=$3 WHERE id=$1 AND organization_id=$4',
    [siteId, after.site, version, after.site.organizationId],
  );
  for (const dock of after.docks)
    await c.query(
      'INSERT INTO docks(id,site_id,data) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET data=excluded.data',
      [dock.id, siteId, dock],
    );
  for (const a of after.appointments) {
    const old = before.appointments.find((x) => x.id === a.id);
    if (old && JSON.stringify(old) === JSON.stringify(a)) continue;
    a.version = old ? old.version + 1 : 1;
    await c.query(
      'INSERT INTO appointments(id,organization_id,site_id,external_id,version,data) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET external_id=excluded.external_id, version=excluded.version, data=excluded.data',
      [a.id, a.organizationId, siteId, a.externalId, a.version, a],
    );
  }
  for (const v of after.visits)
    await c.query(
      'INSERT INTO visits(appointment_id,data) VALUES($1,$2) ON CONFLICT(appointment_id) DO UPDATE SET data=excluded.data',
      [v.appointmentId, v],
    );
  for (const b of before.blocks.filter((b) => !after.blocks.some((x) => x.id === b.id)))
    await c.query('DELETE FROM dock_blocks WHERE id=$1 AND site_id=$2', [b.id, siteId]);
  for (const b of after.blocks)
    await c.query(
      'INSERT INTO dock_blocks(id,dock_id,site_id,start_at,end_at,data) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(id) DO UPDATE SET start_at=excluded.start_at,end_at=excluded.end_at,data=excluded.data',
      [b.id, b.dockId, siteId, b.startAt, b.endAt, b],
    );
  const replaced = before.allocations
    .filter(
      (old) =>
        !after.allocations.some((a) => a.appointmentId === old.appointmentId && sameSlot(a, old)),
    )
    .map((a) => a.id);
  if (replaced.length)
    await c.query(
      "UPDATE dock_allocations SET state='superseded' WHERE id=ANY($1::text[]) AND site_id=$2",
      [replaced, siteId],
    );
  for (const a of after.allocations) {
    if (before.allocations.some((old) => old.appointmentId === a.appointmentId && sameSlot(a, old)))
      continue;
    a.id = uid('alloc');
    a.planVersion = version;
    await c.query(
      "INSERT INTO dock_allocations(id,appointment_id,dock_id,site_id,start_at,end_at,state,plan_version) VALUES($1,$2,$3,$4,$5,$6,'active',$7)",
      [a.id, a.appointmentId, a.dockId, siteId, a.startAt, a.endAt, version],
    );
  }
  await c.query(
    'INSERT INTO plans(id,site_id,version,previous_version,applied_by) VALUES($1,$2,$3,$4,$5)',
    [uid('plan'), siteId, version, version - 1, actor],
  );
}
export async function event(
  c: Client,
  args: {
    organizationId: string;
    siteId: string | null;
    actor: string;
    source?: string;
    action: string;
    resourceId: string;
    before?: unknown;
    after?: unknown;
  },
) {
  await c.query(
    'INSERT INTO audit_events(organization_id,site_id,actor,source,action,resource_type,resource_id,before_json,after_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)',
    [
      args.organizationId,
      args.siteId,
      args.actor,
      args.source || 'api',
      args.action,
      args.action.split('.')[0],
      args.resourceId,
      args.before ?? null,
      args.after ?? null,
    ],
  );
  await c.query(
    'INSERT INTO outbox_events(organization_id,site_id,name,payload_json) VALUES($1,$2,$3,$4)',
    [
      args.organizationId,
      args.siteId,
      args.action,
      { resourceId: args.resourceId, data: args.after ?? null },
    ],
  );
}
