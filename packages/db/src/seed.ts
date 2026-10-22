import { DateTime } from 'luxon';
import argon2 from 'argon2';
import { appointmentInput, dockInput, newVisit, siteInput, type Snapshot } from '@dockslot/domain';
import { event, persist, transaction, pool } from './index.js';
export const demoIds = { organization: 'org_local', site: 'site_main', user: 'local_operator' };
export async function seed(db = pool) {
  if (process.env.DEMO_MODE !== 'true')
    throw new Error('Seed requires DEMO_MODE=true');
  const password = process.env.DEMO_PASSWORD || 'dockslot-local-change-me';
  const hash =
    process.env.AUTH_MODE === 'session'
      ? await argon2.hash(password, { type: argon2.argon2id })
      : null;
  return transaction(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock(859342)');
    if ((await c.query('SELECT 1 FROM sites WHERE id=$1', [demoIds.site])).rowCount)
      return 'Seed already exists; no data overwritten';
    await c.query('INSERT INTO organizations(id,name) VALUES($1,$2) ON CONFLICT(id) DO UPDATE SET name=$2', [
      demoIds.organization,
      'Northstar Logistics',
    ]);
    if (hash) {
      await c.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
        demoIds.user,
        process.env.DEMO_EMAIL || 'admin@dockslot.local',
        hash,
      ]);
      await c.query(
        "INSERT INTO memberships(id,organization_id,user_id,role) VALUES('member_main',$1,$2,'org_admin')",
        [demoIds.organization, demoIds.user],
      );
    }
    const site = {
      ...siteInput.parse({
        name: 'Riverside Distribution Center',
        timezone: 'America/Sao_Paulo',
        address: '1200 Riverside Avenue',
        instructions: 'Use the north gate. Have your booking reference ready.',
      }),
      id: demoIds.site,
      organizationId: demoIds.organization,
      currentPlanVersion: 1,
    };
    const blank: Snapshot = {
        site,
        docks: [],
        blocks: [],
        appointments: [],
        allocations: [],
        visits: [],
      },
      data = structuredClone(blank);
    await c.query('INSERT INTO sites(id,organization_id,data) VALUES($1,$2,$3)', [
      site.id,
      site.organizationId,
      site,
    ]);
    for (let d = 1; d <= 6; d++)
      data.docks.push({
        ...dockInput.parse({
          code: `Dock ${String(d).padStart(2, '0')}`,
          operationType: d <= 2 ? 'inbound' : d <= 4 ? 'outbound' : 'both',
          capabilities: d === 6 ? ['reefer', 'liftgate'] : ['liftgate'],
        }),
        id: `dock_${d}`,
        siteId: site.id,
      });
    const day = DateTime.now().setZone(site.timezone).startOf('day');
    const carriers = [
      'FedEx Freight',
      'DHL Supply Chain',
      'Maersk Logistics',
      'XPO Logistics',
      'DB Schenker',
      'Kuehne + Nagel',
      'Ryder',
      'J.B. Hunt',
    ];
    const durationsByDock = [75, 60, 85, 45, 70, 90];
    for (let i = 0; i < 25; i++) {
      const dock = data.docks[i % 6],
        durationMinutes = i === 24 ? 60 : durationsByDock[i % 6],
        start = day.plus({ hours: 8 + Math.floor(i / 6) * 2 }),
        startAt = start.toUTC().toISO()!;
      const a = {
        ...appointmentInput.parse({
          siteId: site.id,
          reference: `DS-${1041 + i}`,
          carrierName: carriers[i % carriers.length],
          vehicle: `NS-${2100 + i}`,
          operationType: dock.operationType === 'outbound' ? 'outbound' : 'inbound',
          etaAt: startAt,
          earliestStartAt: day.plus({ hours: 7 }).toUTC().toISO(),
          latestStartAt: day.plus({ hours: 18 }).toUTC().toISO(),
          durationMinutes,
          priority: i % 7 === 0 ? 5 : 2,
          locked: i === 3,
          requiredCapabilities: i % 6 === 5 ? ['reefer'] : [],
          cargo: i % 2 ? 'Palletized consumer goods' : 'Industrial components',
        }),
        id: `apt_${i + 1}`,
        organizationId: site.organizationId,
        status: 'confirmed' as const,
        createdAt: day.minus({ days: 1 }).toUTC().toISO()!,
        version: 1,
      };
      data.appointments.push(a);
      data.allocations.push({
        id: `seed_${i}`,
        appointmentId: a.id,
        dockId: dock.id,
        startAt,
        endAt: start.plus({ minutes: durationMinutes }).toUTC().toISO()!,
        planVersion: 2,
      });
      const visit = newVisit(a.id);
      if (i === 0)
        Object.assign(visit, {
          status: 'service_completed',
          checkedInAt: start.minus({ minutes: 12 }).toUTC().toISO(),
          serviceStartedAt: startAt,
          serviceCompletedAt: start.plus({ minutes: 52 }).toUTC().toISO(),
        });
      else if (i < 3)
        Object.assign(visit, {
          status: 'in_service',
          checkedInAt: start.minus({ minutes: 10 }).toUTC().toISO(),
          serviceStartedAt: startAt,
        });
      else if (i < 6)
        Object.assign(visit, {
          status: 'checked_in',
          checkedInAt: start.minus({ minutes: 5 }).toUTC().toISO(),
        });
      data.visits.push(visit);
    }
    await persist(c, blank, data, demoIds.user);
    await event(c, {
      organizationId: site.organizationId,
      siteId: site.id,
      actor: demoIds.user,
      source: 'seed',
      action: 'site.initialized',
      resourceId: site.id,
      after: { appointments: 25, docks: 6 },
    });
    return 'Created 6 docks and 25 appointments';
  }, db);
}
