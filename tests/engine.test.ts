import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import {
  overlaps,
  violations,
  withinHours,
  transition,
  newVisit,
  addMinutes,
} from '@dockslot/domain';
import { replan, searchSlots } from '@dockslot/engine';
import { fixture, request } from './fixtures.js';
describe('intervals, calendar and lifecycle', () => {
  it('uses half-open intervals', () => {
    expect(
      overlaps(
        { startAt: '2026-11-04T12:00Z', endAt: '2026-11-04T13:00Z' },
        { startAt: '2026-11-04T13:00Z', endAt: '2026-11-04T14:00Z' },
      ),
    ).toBe(false);
  });
  it('requires check-in before service and completion before checkout', () => {
    const v = newVisit('a');
    expect(() => transition(v, 'start-service', request.startAt)).toThrow();
    const checked = transition(v, 'check-in', request.startAt);
    expect(() => transition(checked, 'check-out', request.startAt)).toThrow();
    expect(
      transition(
        transition(checked, 'start-service', request.startAt),
        'complete-service',
        request.startAt,
      ).status,
    ).toBe('service_completed');
  });
  it('rejects holidays, incompatible operations, capacity and blocked docks', () => {
    const s = fixture(1);
    const a = s.appointments[0],
      slot = s.allocations[0];
    s.docks[0].operationType = 'outbound';
    s.docks[0].maxWeightTons = 10;
    a.weightTons = 20;
    s.site.policy.holidays = ['2026-11-04'];
    s.blocks.push({
      id: 'block',
      dockId: slot.dockId,
      startAt: slot.startAt,
      endAt: slot.endAt,
      reason: 'Maintenance',
    });
    expect(violations(s, a, slot)).toHaveLength(4);
  });
  it('handles spring DST gap without inventing local 02:00', () => {
    const s = fixture(1);
    s.site.policy.open = '00:00';
    s.site.policy.close = '05:00';
    const a = s.appointments[0];
    a.earliestStartAt = '2026-03-08T05:00:00.000Z';
    a.latestStartAt = '2026-03-08T09:00:00.000Z';
    a.etaAt = null;
    const result = searchSlots(s, a, a.earliestStartAt, '2026-03-08T10:00:00.000Z', []);
    expect(result.slots.length).toBeGreaterThan(0);
    expect(result.slots.every((x) => withinHours(s.site, x))).toBe(true);
    expect(
      result.slots.some(
        (x) =>
          new Intl.DateTimeFormat('en', {
            timeZone: s.site.timezone,
            hour: '2-digit',
            hour12: false,
          }).format(new Date(x.startAt)) === '02',
      ),
    ).toBe(false);
  });
  it('keeps both repeated fall DST hours distinct in UTC', () => {
    const s = fixture(1);
    s.site.policy.open = '00:00';
    s.site.policy.close = '04:00';
    const a = s.appointments[0];
    a.earliestStartAt = '2026-11-01T04:00:00.000Z';
    a.latestStartAt = '2026-11-01T08:00:00.000Z';
    a.etaAt = null;
    const result = searchSlots(s, a, a.earliestStartAt, '2026-11-01T09:00:00.000Z', []);
    expect(result.slots.some((x) => x.startAt === '2026-11-01T05:00:00.000Z')).toBe(true);
    expect(result.slots.some((x) => x.startAt === '2026-11-01T06:00:00.000Z')).toBe(true);
  });
});
describe('recovery engine', () => {
  it('is deterministic and never mutates the snapshot', () => {
    const s = fixture(),
      original = structuredClone(s);
    expect(replan(s, request)).toEqual(replan(s, request));
    expect(s).toEqual(original);
  });
  it('never moves locked or in-service work', () => {
    const s = fixture();
    s.appointments[0].locked = true;
    s.visits[1].status = 'in_service';
    s.appointments[2].etaAt = addMinutes(s.allocations[2].startAt, 90);
    const p = replan(s, request);
    expect(p.assignments[0].from).toEqual(p.assignments[0].to);
    expect(p.assignments[1].from).toEqual(p.assignments[1].to);
    expect(p.applicable).toBe(true);
    expect(p.metrics.movedCount).toBeGreaterThan(0);
  });
  it('reports infeasibility and unknown ETA honestly', () => {
    const s = fixture(1, 1);
    s.appointments[0].etaAt = null;
    s.docks[0].status = 'maintenance';
    const p = replan(s, request);
    expect(p.applicable).toBe(false);
    expect(p.unscheduled).toHaveLength(1);
    expect(p.metrics.totalProjectedWaitingMinutes).toBeNull();
    expect(p.warnings.length).toBe(1);
  });
  it('an outage intersecting immutable service prevents apply', () => {
    const s = fixture(1);
    s.appointments[0].locked = true;
    s.blocks.push({
      id: 'b',
      dockId: 'dock_0',
      startAt: s.allocations[0].startAt,
      endAt: s.allocations[0].endAt,
      reason: 'Outage',
    });
    expect(replan(s, request).applicable).toBe(false);
  });
  it('every applicable generated proposal respects all hard constraints', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 14 }),
        fc.integer({ min: 0, max: 180 }),
        fc.integer({ min: 1, max: 4 }),
        (count, delay, docks) => {
          const s = fixture(count, docks);
          s.appointments[0].etaAt = addMinutes(s.appointments[0].etaAt!, delay);
          const p = replan(s, request);
          if (p.applicable) {
            const allocations = p.assignments
              .filter((x) => x.to)
              .map((x) => ({
                ...x.to!,
                appointmentId: x.appointmentId,
                id: x.appointmentId,
                planVersion: 2,
              }));
            expect(p.metrics.hardConstraintViolations).toBe(0);
            for (const slot of allocations)
              expect(
                violations(
                  s,
                  s.appointments.find((a) => a.id === slot.appointmentId)!,
                  slot,
                  allocations,
                ),
              ).toEqual([]);
          }
        },
      ),
      { numRuns: 30 },
    );
  });
});
