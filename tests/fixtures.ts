import { appointmentInput, dockInput, siteInput, newVisit, type Snapshot } from '@dockslot/domain';
export function fixture(count = 8, docks = 3): Snapshot {
  const site = {
    ...siteInput.parse({ name: 'Test warehouse', timezone: 'America/New_York' }),
    id: 'site_test',
    organizationId: 'org_test',
    currentPlanVersion: 1,
  };
  const s: Snapshot = {
    site,
    docks: [],
    appointments: [],
    allocations: [],
    blocks: [],
    visits: [],
  };
  for (let i = 0; i < docks; i++)
    s.docks.push({
      ...dockInput.parse({ code: `Dock ${i}`, capabilities: ['liftgate', 'reefer'] }),
      id: `dock_${i}`,
      siteId: site.id,
    });
  for (let i = 0; i < count; i++) {
    const start = new Date(
      Date.parse('2026-11-04T12:00:00Z') + Math.floor(i / docks) * 3600000,
    ).toISOString();
    const a = {
      ...appointmentInput.parse({
        siteId: site.id,
        carrierName: 'Example carrier',
        reference: `PO-${i}`,
        operationType: 'inbound',
        earliestStartAt: '2026-11-04T12:00:00Z',
        latestStartAt: '2026-11-04T23:00:00Z',
        etaAt: start,
        durationMinutes: 60,
      }),
      id: `apt_${i}`,
      organizationId: site.organizationId,
      createdAt: '2026-11-03T12:00:00Z',
      status: 'confirmed' as const,
      version: 1,
    };
    s.appointments.push(a);
    s.visits.push(newVisit(a.id));
    s.allocations.push({
      id: `alloc_${i}`,
      appointmentId: a.id,
      dockId: s.docks[i % docks].id,
      startAt: start,
      endAt: new Date(Date.parse(start) + 3600000).toISOString(),
      planVersion: 1,
    });
  }
  return s;
}
export const request = {
  startAt: '2026-11-04T12:00:00.000Z',
  endAt: '2026-11-05T00:00:00.000Z',
  reason: 'late_arrival' as const,
  overrides: [],
};
