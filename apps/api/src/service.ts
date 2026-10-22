import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  assert,
  addMinutes,
  appointmentInput,
  fixed,
  newVisit,
  sameSlot,
  transition,
  violations,
  type Appointment,
  type Permission,
  type ReplanRequest,
  type Slot,
  type Snapshot,
} from '@dockslot/domain';
import { event, persist, snapshot, transaction, uid, pool, type Client } from '@dockslot/db';
import { replan, searchSlots } from '@dockslot/engine';
import { authorize, type Principal } from './security.js';
export class Service {
  constructor(readonly db = pool) {}
  async read(p: Principal, siteId: string) {
    authorize(p, 'read', siteId);
    return transaction(async (c) => {
      await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const s = await snapshot(c, siteId, p.organizationId);
      assert(s, 404, 'Site not found');
      return s;
    }, this.db);
  }
  async appointmentSite(p: Principal, appointmentId: string) {
    const row = (
      await this.db.query('SELECT site_id FROM appointments WHERE id=$1 AND organization_id=$2', [
        appointmentId,
        p.organizationId,
      ])
    ).rows[0];
    assert(row, 404, 'Appointment not found');
    authorize(p, 'read', row.site_id);
    return row.site_id as string;
  }
  async dockSite(p: Principal, dockId: string) {
    const row = (
      await this.db.query(
        'SELECT d.site_id FROM docks d JOIN sites s ON s.id=d.site_id WHERE d.id=$1 AND s.organization_id=$2',
        [dockId, p.organizationId],
      )
    ).rows[0];
    assert(row, 404, 'Dock not found');
    authorize(p, 'read', row.site_id);
    return row.site_id as string;
  }
  async mutate<T>(
    p: Principal,
    siteId: string,
    permission: Permission,
    action: string,
    resourceId: string,
    fn: (s: Snapshot, c: Client) => Promise<T> | T,
    expectedVersion?: number,
    idempotency?: { key: string; body: unknown },
  ) {
    authorize(p, permission, siteId);
    return transaction(async (c) => {
      if (idempotency) {
        await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          `${p.organizationId}:${p.id}:${idempotency.key}`,
        ]);
        const existing = (
          await c.query(
            'SELECT * FROM idempotency_keys WHERE organization_id=$1 AND actor=$2 AND key=$3',
            [p.organizationId, p.id, idempotency.key],
          )
        ).rows[0];
        if (existing) {
          assert(
            existing.request_hash ===
              createHash('sha256').update(JSON.stringify(idempotency.body)).digest('hex'),
            409,
            'Idempotency key was already used with different input',
          );
          return existing.response_json as T;
        }
      }
      const s = await snapshot(c, siteId, p.organizationId, true);
      assert(s, 404, 'Site not found');
      if (expectedVersion !== undefined)
        assert(
          s.site.currentPlanVersion === expectedVersion,
          409,
          'Plan changed. Refresh and generate a new proposal.',
        );
      const before = structuredClone(s),
        result = await fn(s, c);
      await persist(c, before, s, p.id);
      await event(c, {
        organizationId: p.organizationId,
        siteId,
        actor: p.id,
        source: p.source,
        action,
        resourceId,
        before,
        after: s,
      });
      if (idempotency)
        await c.query(
          'INSERT INTO idempotency_keys(organization_id,actor,key,request_hash,response_json) VALUES($1,$2,$3,$4,$5)',
          [
            p.organizationId,
            p.id,
            idempotency.key,
            createHash('sha256').update(JSON.stringify(idempotency.body)).digest('hex'),
            JSON.stringify(result),
          ],
        );
      return result;
    }, this.db);
  }
  async create(p: Principal, input: unknown, key?: string) {
    const body = appointmentInput.parse(input),
      appointmentId = uid('apt');
    return this.mutate(
      p,
      body.siteId,
      'plan',
      'appointment.requested',
      appointmentId,
      (s) => {
        const a: Appointment = {
          ...body,
          id: appointmentId,
          organizationId: p.organizationId,
          status: 'requested',
          version: 1,
          createdAt: new Date().toISOString(),
        };
        s.appointments.push(a);
        s.visits.push(newVisit(a.id));
        return a;
      },
      undefined,
      key ? { key, body } : undefined,
    );
  }
  async update(
    p: Principal,
    appointmentId: string,
    input: Record<string, unknown>,
    expectedVersion: number,
  ) {
    const siteId = await this.appointmentSite(p, appointmentId);
    return this.mutate(p, siteId, 'plan', 'appointment.updated', appointmentId, (s) => {
      const a = s.appointments.find((a) => a.id === appointmentId)!;
      assert(a.version === expectedVersion, 409, 'Appointment changed. Refresh before editing');
      const onlyLock = Object.keys(input).every((k) => k === 'locked');
      if (a.locked && input.locked === false) authorize(p, 'manage', siteId);
      assert(
        onlyLock ||
          !fixed(
            a,
            s.visits.find((v) => v.appointmentId === a.id),
          ),
        409,
        'Appointment is locked or service has started',
      );
      assert(!input.siteId || input.siteId === siteId, 400, 'Cannot change the appointment site');
      const next = { ...a, ...appointmentInput.parse({ ...a, ...input }) };
      const allocation = s.allocations.find((x) => x.appointmentId === a.id);
      if (allocation && !onlyLock) {
        const errors = violations(s, next, allocation);
        assert(
          !errors.length,
          409,
          'Edit conflicts with the current allocation; use ETA update or recovery',
          errors,
        );
      }
      Object.assign(a, next);
      return a;
    });
  }
  async confirm(
    p: Principal,
    appointmentId: string,
    slot: { dockId: string; startAt: string },
    expectedVersion: number,
  ) {
    const siteId = await this.appointmentSite(p, appointmentId);
    return this.mutate(
      p,
      siteId,
      'plan',
      'appointment.confirmed',
      appointmentId,
      async (s, c) => {
        const a = s.appointments.find((a) => a.id === appointmentId)!;
        assert(
          ['requested', 'confirmed'].includes(a.status),
          409,
          'Only requested or confirmed appointments can be allocated',
        );
        assert(
          !fixed(
            a,
            s.visits.find((v) => v.appointmentId === a.id),
          ),
          409,
          'Appointment is locked or service has started',
        );
        const allocation = {
          ...slot,
          endAt: addMinutes(slot.startAt, a.durationMinutes),
          id: uid('alloc'),
          appointmentId,
          planVersion: s.site.currentPlanVersion + 1,
        };
        const errors = violations(s, a, allocation);
        assert(!errors.length, 409, 'Slot is unavailable', errors);
        const old = s.allocations.find((x) => x.appointmentId === a.id);
        s.allocations = s.allocations.filter((x) => x.appointmentId !== a.id);
        s.allocations.push(allocation);
        a.status = 'confirmed';
        a.version += 1;
        if (old && !sameSlot(old, allocation))
          await event(c, {
            organizationId: p.organizationId,
            siteId,
            actor: p.id,
            source: p.source,
            action: 'appointment.rescheduled',
            resourceId: a.id,
            before: old,
            after: allocation,
          });
        return {
          appointment: a,
          allocation,
          previousAllocation: old,
          planVersion: s.site.currentPlanVersion + 1,
        };
      },
      expectedVersion,
    );
  }
  async visit(p: Principal, appointmentId: string, action: string) {
    const siteId = await this.appointmentSite(p, appointmentId),
      eventNames: Record<string, string> = {
        'check-in': 'checked_in',
        'start-service': 'service_started',
        'complete-service': 'service_completed',
        'check-out': 'checked_out',
      };
    return this.mutate(
      p,
      siteId,
      ['check-in', 'check-out'].includes(action) ? 'gate' : 'dock',
      `visit.${eventNames[action]}`,
      appointmentId,
      (s) => {
        const a = s.appointments.find((a) => a.id === appointmentId)!;
        assert(
          a.status === 'confirmed' || (action === 'check-out' && a.status === 'fulfilled'),
          409,
          'Appointment must be confirmed',
        );
        const visit = s.visits.find((v) => v.appointmentId === appointmentId)!;
        if (action === 'start-service') {
          const allocation = s.allocations.find((x) => x.appointmentId === appointmentId);
          assert(allocation, 409, 'A dock allocation is required');
          assert(
            !s.visits.some(
              (v) =>
                v.status === 'in_service' &&
                v.appointmentId !== appointmentId &&
                s.allocations.some(
                  (x) => x.appointmentId === v.appointmentId && x.dockId === allocation.dockId,
                ),
            ),
            409,
            'Dock is physically occupied; complete the current service first',
          );
          assert(
            s.docks.find((d) => d.id === allocation.dockId)?.status === 'available',
            409,
            'Dock is not operational',
          );
          const now = new Date().toISOString();
          assert(
            !s.blocks.some(
              (b) => b.dockId === allocation.dockId && b.startAt <= now && now < b.endAt,
            ),
            409,
            'Dock is blocked now',
          );
        }
        Object.assign(visit, transition(visit, action, new Date().toISOString()));
        a.version += 1;
        if (action === 'complete-service') a.status = 'fulfilled';
        return visit;
      },
    );
  }
  async eta(p: Principal, appointmentId: string, etaAt: string) {
    const siteId = await this.appointmentSite(p, appointmentId);
    return this.mutate(p, siteId, 'plan', 'appointment.eta_updated', appointmentId, (s) => {
      const a = s.appointments.find((a) => a.id === appointmentId)!;
      assert(['requested', 'confirmed'].includes(a.status), 409, 'Appointment is closed');
      assert(
        !['in_service', 'service_completed', 'checked_out'].includes(
          s.visits.find((v) => v.appointmentId === a.id)!.status,
        ),
        409,
        'Service already started',
      );
      a.etaAt = etaAt;
      return a;
    });
  }
  async cancel(p: Principal, appointmentId: string, reason: string, noShow = false) {
    const siteId = await this.appointmentSite(p, appointmentId);
    return this.mutate(
      p,
      siteId,
      'plan',
      noShow ? 'appointment.no_show' : 'appointment.cancelled',
      appointmentId,
      (s) => {
        const a = s.appointments.find((a) => a.id === appointmentId)!,
          v = s.visits.find((v) => v.appointmentId === appointmentId)!;
        assert(
          ['requested', 'confirmed'].includes(a.status) && v.status === 'expected',
          409,
          'Cancellation/no-show requires a pending visit; arrived vehicles need an administrative correction',
        );
        if (noShow) {
          const allocation = s.allocations.find((x) => x.appointmentId === a.id);
          assert(
            allocation &&
              Date.now() >= Date.parse(allocation.startAt) + s.site.policy.noShowMinutes * 60000,
            409,
            'No-show grace period has not elapsed',
          );
          v.status = 'no_show';
        }
        a.status = noShow ? 'no_show' : 'cancelled';
        a.notes += `\n${noShow ? 'No-show' : 'Cancelled'}: ${reason}`;
        s.allocations = s.allocations.filter((x) => x.appointmentId !== a.id);
        return a;
      },
    );
  }
  async propose(p: Principal, siteId: string, request: ReplanRequest) {
    authorize(p, 'plan', siteId);
    return transaction(async (c) => {
      const s = await snapshot(c, siteId, p.organizationId, true);
      assert(s, 404, 'Site not found');
      for (const o of request.overrides)
        assert(
          s.appointments.some((a) => a.id === o.appointmentId),
          400,
          'Override appointment is not in this site',
        );
      const proposal = replan(s, request, uid('rp'));
      await c.query(
        'INSERT INTO replan_proposals(id,site_id,baseline_plan_version,snapshot_json,request_json,proposal_json,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [proposal.id, siteId, s.site.currentPlanVersion, s, request, proposal, p.id],
      );
      await event(c, {
        organizationId: p.organizationId,
        siteId,
        actor: p.id,
        source: p.source,
        action: 'replan.generated',
        resourceId: proposal.id,
        after: proposal,
      });
      return proposal;
    }, this.db);
  }
  async proposal(p: Principal, proposalId: string) {
    const row = (
      await this.db.query(
        'SELECT r.* FROM replan_proposals r JOIN sites s ON s.id=r.site_id WHERE r.id=$1 AND s.organization_id=$2',
        [proposalId, p.organizationId],
      )
    ).rows[0];
    assert(row, 404, 'Proposal not found');
    authorize(p, 'read', row.site_id);
    return row;
  }
  async apply(p: Principal, proposalId: string, expectedVersion: number) {
    const row = await this.proposal(p, proposalId);
    return this.mutate(
      p,
      row.site_id,
      'plan',
      'replan.applied',
      proposalId,
      async (s, c) => {
        const current = (
          await c.query('SELECT * FROM replan_proposals WHERE id=$1 FOR UPDATE', [proposalId])
        ).rows[0];
        assert(current.status === 'pending', 409, 'Proposal is already applied or rejected');
        assert(
          current.baseline_plan_version === expectedVersion,
          409,
          'Proposal was based on a different plan version',
        );
        const proposal = replan(s, current.request_json, proposalId);
        assert(
          proposal.applicable,
          422,
          'Proposal is not feasible; resolve unscheduled or fixed conflicts first',
          proposal,
        );
        assert(
          isDeepStrictEqual(proposal, current.proposal_json),
          409,
          'Proposal inputs changed; regenerate',
        );
        for (const override of (current.request_json as ReplanRequest).overrides) {
          const a = s.appointments.find((x) => x.id === override.appointmentId)!;
          if (
            !fixed(
              a,
              s.visits.find((v) => v.appointmentId === a.id),
            )
          ) {
            if (override.etaAt) a.etaAt = override.etaAt;
            if (override.locked) a.locked = true;
          }
        }
        for (const assignment of proposal.assignments) {
          if (sameSlot(assignment.from, assignment.to)) continue;
          assert(assignment.to && !assignment.locked, 422, 'Unsafe assignment');
          const a = s.appointments.find((a) => a.id === assignment.appointmentId)!;
          s.allocations = s.allocations.filter((x) => x.appointmentId !== a.id);
          s.allocations.push({
            ...assignment.to,
            id: uid('alloc'),
            appointmentId: a.id,
            planVersion: expectedVersion + 1,
          });
          a.status = 'confirmed';
          a.version += 1;
          await event(c, {
            organizationId: p.organizationId,
            siteId: s.site.id,
            actor: p.id,
            source: p.source,
            action: 'appointment.rescheduled',
            resourceId: a.id,
            before: assignment.from,
            after: { ...assignment.to, reasons: assignment.reasons },
          });
        }
        await c.query("UPDATE replan_proposals SET status='applied',applied_at=now() WHERE id=$1", [
          proposalId,
        ]);
        return {
          id: proposalId,
          status: 'applied',
          planVersion: expectedVersion + 1,
          movedCount: proposal.metrics.movedCount,
        };
      },
      expectedVersion,
    );
  }
}
