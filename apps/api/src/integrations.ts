import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';
import argon2 from 'argon2';
import {
  addMinutes,
  appointmentInput,
  appointmentFields,
  assert,
  id,
  iso,
  newVisit,
  roleSchema,
  violations,
  type Appointment,
  type Snapshot,
} from '@dockslot/domain';
import { event, pool, transaction, uid } from '@dockslot/db';
import { searchSlots } from '@dockslot/engine';
import { Service } from './service.js';
import {
  authorize,
  encrypt,
  hashToken,
  secretToken,
  webhookTarget,
  type Principal,
} from './security.js';
const csvColumns = [
  'reference',
  'carrierName',
  'vehicle',
  'operationType',
  'etaAt',
  'earliestStartAt',
  'latestStartAt',
  'durationMinutes',
  'priority',
  'requiredCapabilities',
  'externalId',
  'dockId',
  'startAt',
];
export function importRows(csv: string, snapshot: Snapshot) {
  let records: Record<string, string>[];
  try {
    records = parse(csv, {
      columns: (headers: string[]) => {
        assert(
          headers.every((h) => csvColumns.includes(h)) && headers.length === new Set(headers).size,
          400,
          'Unknown or duplicate CSV column',
        );
        return headers;
      },
      bom: true,
      skip_empty_lines: true,
      trim: true,
      max_record_size: 10000,
    });
  } catch (error) {
    return { errors: [{ row: 0, message: (error as Error).message }], rows: [] };
  }
  assert(records.length <= 500, 400, 'Import up to 500 rows at a time');
  const errors: { row: number; message: string }[] = [],
    rows: { appointment: Appointment; dockId?: string; startAt?: string }[] = [],
    state = structuredClone(snapshot);
  for (let i = 0; i < records.length; i++) {
    try {
      const r = records[i],
        a: Appointment = {
          ...appointmentInput.parse({
            ...r,
            siteId: state.site.id,
            etaAt: r.etaAt || null,
            externalId: r.externalId || null,
            durationMinutes: Number(r.durationMinutes),
            priority: Number(r.priority || 2),
            requiredCapabilities: r.requiredCapabilities?.split('|').filter(Boolean) || [],
          }),
          id: uid('apt'),
          organizationId: state.site.organizationId,
          version: 1,
          createdAt: new Date().toISOString(),
          status: r.dockId ? 'confirmed' : 'requested',
        };
      assert(
        !a.externalId || !state.appointments.some((x) => x.externalId === a.externalId),
        409,
        `Duplicate externalId: ${a.externalId}`,
      );
      assert(
        !state.appointments.some((x) => x.reference === a.reference),
        409,
        `Duplicate reference: ${a.reference}`,
      );
      assert(!!r.dockId === !!r.startAt, 400, 'dockId and startAt must be supplied together');
      if (r.dockId) {
        const startAt = iso.parse(r.startAt),
          allocation = {
            id: uid('alloc'),
            appointmentId: a.id,
            dockId: r.dockId,
            startAt,
            endAt: addMinutes(startAt, a.durationMinutes),
            planVersion: state.site.currentPlanVersion + 1,
          };
        const problems = violations(state, a, allocation);
        assert(!problems.length, 409, problems.join('; '));
        state.allocations.push(allocation);
      }
      state.appointments.push(a);
      rows.push({
        appointment: a,
        dockId: r.dockId,
        startAt: r.startAt ? iso.parse(r.startAt) : undefined,
      });
    } catch (error) {
      errors.push({ row: i + 2, message: (error as Error).message });
    }
  }
  return { errors, rows };
}
export async function integrations(instance: FastifyInstance, svc: Service, db = pool) {
  const app = instance.withTypeProvider<ZodTypeProvider>();
  const params = z.object({ id });
  app.get(
    '/v1/organizations/current',
    { schema: { tags: ['Admin'] } },
    async (req) =>
      (
        await db.query('SELECT id,name,created_at FROM organizations WHERE id=$1', [
          req.principal.organizationId,
        ])
      ).rows[0],
  );
  app.patch(
    '/v1/organizations/current',
    { schema: { tags: ['Admin'], body: z.object({ name: z.string().min(1).max(150) }) } },
    async (req) => {
      authorize(req.principal, 'admin');
      await transaction(async (c) => {
        await c.query('UPDATE organizations SET name=$2 WHERE id=$1', [
          req.principal.organizationId,
          req.body.name,
        ]);
        await event(c, {
          organizationId: req.principal.organizationId,
          siteId: null,
          actor: req.principal.id,
          action: 'organization.updated',
          resourceId: req.principal.organizationId,
          after: req.body,
        });
      }, db);
      return req.body;
    },
  );
  app.get('/v1/members', { schema: { tags: ['Admin'] } }, async (req) => {
    authorize(req.principal, 'admin');
    return (
      await db.query(
        'SELECT m.id,m.site_id,m.role,u.id AS user_id,u.email,u.active FROM memberships m JOIN users u ON u.id=m.user_id WHERE organization_id=$1',
        [req.principal.organizationId],
      )
    ).rows;
  });
  app.post(
    '/v1/members',
    {
      schema: {
        tags: ['Admin'],
        body: z.object({
          email: z.email(),
          password: z.string().min(12).max(200),
          role: roleSchema,
          siteId: id.nullable().default(null),
        }),
      },
    },
    async (req) => {
      authorize(req.principal, 'admin');
      if (req.body.siteId) await svc.read(req.principal, req.body.siteId);
      assert(
        req.body.role !== 'org_admin' || !req.body.siteId,
        400,
        'Organization admins must have organization-wide membership',
      );
      return transaction(async (c) => {
        const userId = uid('user'),
          membershipId = uid('membership');
        await c.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
          userId,
          req.body.email.toLowerCase(),
          await argon2.hash(req.body.password, { type: argon2.argon2id }),
        ]);
        await c.query(
          'INSERT INTO memberships(id,organization_id,site_id,user_id,role) VALUES($1,$2,$3,$4,$5)',
          [membershipId, req.principal.organizationId, req.body.siteId, userId, req.body.role],
        );
        await event(c, {
          organizationId: req.principal.organizationId,
          siteId: req.body.siteId,
          actor: req.principal.id,
          action: 'membership.created',
          resourceId: membershipId,
          after: { userId, role: req.body.role },
        });
        return { id: membershipId, userId };
      }, db);
    },
  );
  app.delete('/v1/members/:id', { schema: { tags: ['Admin'], params } }, async (req) => {
    authorize(req.principal, 'admin');
    return transaction(async (c) => {
      const member = (
        await c.query('SELECT * FROM memberships WHERE id=$1 AND organization_id=$2 FOR UPDATE', [
          req.params.id,
          req.principal.organizationId,
        ])
      ).rows[0];
      assert(member, 404, 'Membership not found');
      assert(member.user_id !== req.principal.id, 409, 'Cannot remove your own membership');
      await c.query('DELETE FROM memberships WHERE id=$1', [member.id]);
      await c.query('DELETE FROM sessions WHERE user_id=$1', [member.user_id]);
      await event(c, {
        organizationId: req.principal.organizationId,
        siteId: member.site_id,
        actor: req.principal.id,
        action: 'membership.revoked',
        resourceId: member.id,
      });
      return { ok: true };
    }, db);
  });
  app.post(
    '/v1/integrations/tokens',
    {
      schema: {
        tags: ['Integrations'],
        body: z.object({
          name: z.string().min(1).max(100),
          siteId: id.nullable().default(null),
          scopes: z.array(z.enum(['read', 'plan', 'gate', 'dock', 'manage'])).min(1),
          expiresAt: iso,
        }),
      },
    },
    async (req) => {
      authorize(req.principal, 'admin');
      if (req.body.siteId) await svc.read(req.principal, req.body.siteId);
      assert(Date.parse(req.body.expiresAt) > Date.now(), 400, 'Expiry must be in the future');
      const token = secretToken(),
        tokenId = uid('token');
      await transaction(async (c) => {
        await c.query(
          'INSERT INTO api_tokens(id,organization_id,site_id,name,hashed_token,scopes,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [
            tokenId,
            req.principal.organizationId,
            req.body.siteId,
            req.body.name,
            hashToken(token),
            req.body.scopes,
            req.body.expiresAt,
          ],
        );
        await event(c, {
          organizationId: req.principal.organizationId,
          siteId: req.body.siteId,
          actor: req.principal.id,
          action: 'token.created',
          resourceId: tokenId,
          after: { name: req.body.name, scopes: req.body.scopes },
        });
      }, db);
      return { id: tokenId, token, ...req.body };
    },
  );
  app.get('/v1/integrations/tokens', { schema: { tags: ['Integrations'] } }, async (req) => {
    authorize(req.principal, 'admin');
    return (
      await db.query(
        'SELECT id,name,site_id,scopes,expires_at,last_used_at,revoked_at FROM api_tokens WHERE organization_id=$1',
        [req.principal.organizationId],
      )
    ).rows;
  });
  app.delete(
    '/v1/integrations/tokens/:id',
    { schema: { tags: ['Integrations'], params } },
    async (req) => {
      authorize(req.principal, 'admin');
      const row = await db.query(
        'UPDATE api_tokens SET revoked_at=now() WHERE id=$1 AND organization_id=$2 RETURNING id',
        [req.params.id, req.principal.organizationId],
      );
      assert(row.rowCount, 404, 'Token not found');
      return { ok: true };
    },
  );
  app.post(
    '/v1/integrations/webhooks',
    {
      schema: {
        tags: ['Integrations'],
        body: z.object({
          url: z.url().max(2000),
          eventFilters: z.array(z.string().max(100)).max(50).default([]),
        }),
      },
    },
    async (req) => {
      authorize(req.principal, 'admin');
      await webhookTarget(req.body.url);
      const secret = secretToken(),
        webhookId = uid('wh');
      await transaction(async (c) => {
        await c.query(
          'INSERT INTO webhook_endpoints(id,organization_id,url,encrypted_secret,event_filters) VALUES($1,$2,$3,$4,$5)',
          [
            webhookId,
            req.principal.organizationId,
            req.body.url,
            encrypt(secret),
            req.body.eventFilters,
          ],
        );
        await event(c, {
          organizationId: req.principal.organizationId,
          siteId: null,
          actor: req.principal.id,
          action: 'webhook.created',
          resourceId: webhookId,
          after: { url: req.body.url },
        });
      }, db);
      return { id: webhookId, secret };
    },
  );
  app.get('/v1/integrations/webhooks', { schema: { tags: ['Integrations'] } }, async (req) => {
    authorize(req.principal, 'admin');
    return (
      await db.query(
        'SELECT id,url,active,event_filters,created_at FROM webhook_endpoints WHERE organization_id=$1',
        [req.principal.organizationId],
      )
    ).rows;
  });
  app.delete(
    '/v1/integrations/webhooks/:id',
    { schema: { tags: ['Integrations'], params } },
    async (req) => {
      authorize(req.principal, 'admin');
      const r = await db.query(
        'UPDATE webhook_endpoints SET active=false WHERE id=$1 AND organization_id=$2 RETURNING id',
        [req.params.id, req.principal.organizationId],
      );
      assert(r.rowCount, 404, 'Webhook not found');
      return { ok: true };
    },
  );
  app.get('/v1/integrations/deliveries', { schema: { tags: ['Integrations'] } }, async (req) => {
    authorize(req.principal, 'admin');
    return (
      await db.query(
        'SELECT d.*,e.name,w.url FROM webhook_deliveries d JOIN webhook_endpoints w ON w.id=d.endpoint_id JOIN outbox_events e ON e.id=d.event_id WHERE w.organization_id=$1 ORDER BY d.id DESC LIMIT 200',
        [req.principal.organizationId],
      )
    ).rows;
  });
  app.post(
    '/v1/integrations/deliveries/:id/retry',
    { schema: { tags: ['Integrations'], params } },
    async (req) => {
      authorize(req.principal, 'admin');
      assert(/^\d+$/.test(req.params.id), 400, 'Invalid delivery ID');
      const r = await db.query(
        "UPDATE webhook_deliveries d SET status='pending',attempt=0,next_attempt_at=now() FROM webhook_endpoints w WHERE d.id=$1 AND d.endpoint_id=w.id AND w.organization_id=$2 AND d.status='failed' RETURNING d.id",
        [req.params.id, req.principal.organizationId],
      );
      assert(r.rowCount, 404, 'Failed delivery not found');
      return { ok: true };
    },
  );
  const importBody = z.object({
    siteId: id,
    csv: z.string().min(1).max(1000000),
    expectedPlanVersion: z.number().int().positive().optional(),
  });
  app.post(
    '/v1/imports/appointments/preview',
    { schema: { tags: ['CSV'], body: importBody } },
    async (req) => {
      authorize(req.principal, 'plan', req.body.siteId);
      const s = await svc.read(req.principal, req.body.siteId);
      return { ...importRows(req.body.csv, s), planVersion: s.site.currentPlanVersion };
    },
  );
  app.post(
    '/v1/imports/appointments/commit',
    {
      schema: {
        tags: ['CSV'],
        body: importBody.extend({ expectedPlanVersion: z.number().int().positive() }),
      },
    },
    async (req) =>
      svc.mutate(
        req.principal,
        req.body.siteId,
        'plan',
        'import.committed',
        req.body.siteId,
        async (s, c) => {
          const parsed = importRows(req.body.csv, s);
          assert(
            !parsed.errors.length,
            400,
            'Import rejected. No rows were written.',
            parsed.errors,
          );
          for (const row of parsed.rows) {
            s.appointments.push(row.appointment);
            s.visits.push(newVisit(row.appointment.id));
            if (row.dockId && row.startAt)
              s.allocations.push({
                id: uid('alloc'),
                appointmentId: row.appointment.id,
                dockId: row.dockId,
                startAt: row.startAt,
                endAt: addMinutes(row.startAt, row.appointment.durationMinutes),
                planVersion: s.site.currentPlanVersion + 1,
              });
            await event(c, {
              organizationId: req.principal.organizationId,
              siteId: s.site.id,
              actor: req.principal.id,
              action: `appointment.${row.appointment.status}`,
              resourceId: row.appointment.id,
              after: row.appointment,
            });
          }
          return { imported: parsed.rows.length };
        },
        req.body.expectedPlanVersion,
      ),
  );
  app.get(
    '/v1/exports/appointments.csv',
    { schema: { tags: ['CSV'], querystring: z.object({ siteId: id }) } },
    async (req, reply) => {
      const s = await svc.read(req.principal, req.query.siteId);
      const safe = (value: unknown) =>
        typeof value === 'string' && /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
      return reply
        .type('text/csv')
        .header('Content-Disposition', 'attachment; filename="dockslot-appointments.csv"')
        .send(
          stringify(
            s.appointments.map((a) => {
              const allocation = s.allocations.find((x) => x.appointmentId === a.id);
              return Object.fromEntries(
                csvColumns.map((k) => [
                  k,
                  safe(
                    k === 'requiredCapabilities'
                      ? a.requiredCapabilities.join('|')
                      : k === 'dockId'
                        ? allocation?.dockId || ''
                        : k === 'startAt'
                          ? allocation?.startAt || ''
                          : (a[k as keyof Appointment] ?? ''),
                  ),
                ]),
              );
            }),
            { header: true, columns: csvColumns },
          ),
        );
    },
  );
  app.post(
    '/v1/portal-tokens',
    {
      schema: {
        tags: ['Portal'],
        body: z.object({
          siteId: id,
          appointmentId: id.nullable().default(null),
          expiresAt: iso,
          scopes: z.array(z.enum(['read', 'request'])).min(1),
        }),
      },
    },
    async (req) => {
      authorize(req.principal, 'plan', req.body.siteId);
      await svc.read(req.principal, req.body.siteId);
      if (req.body.appointmentId)
        assert(
          (await svc.appointmentSite(req.principal, req.body.appointmentId)) === req.body.siteId,
          400,
          'Appointment is not in this site',
        );
      assert(
        Date.parse(req.body.expiresAt) > Date.now() &&
          Date.parse(req.body.expiresAt) < Date.now() + 30 * 86400000,
        400,
        'Portal token expiry must be within 30 days',
      );
      const token = secretToken(),
        tokenId = uid('portal');
      await db.query(
        'INSERT INTO portal_tokens(id,appointment_id,site_id,hashed_token,scopes,expires_at) VALUES($1,$2,$3,$4,$5,$6)',
        [
          tokenId,
          req.body.appointmentId,
          req.body.siteId,
          hashToken(token),
          req.body.scopes,
          req.body.expiresAt,
        ],
      );
      return { id: tokenId, token, path: `/portal/${token}` };
    },
  );
  app.delete('/v1/portal-tokens/:id', { schema: { tags: ['Portal'], params } }, async (req) => {
    const r = (
      await db.query(
        'SELECT p.site_id FROM portal_tokens p JOIN sites s ON s.id=p.site_id WHERE p.id=$1 AND s.organization_id=$2',
        [req.params.id, req.principal.organizationId],
      )
    ).rows[0];
    assert(r, 404, 'Portal token not found');
    authorize(req.principal, 'plan', r.site_id);
    await db.query('UPDATE portal_tokens SET revoked_at=now() WHERE id=$1', [req.params.id]);
    return { ok: true };
  });
  async function portal(token: string) {
    const row = (
      await db.query(
        'SELECT p.*,s.organization_id,s.data AS site FROM portal_tokens p JOIN sites s ON s.id=p.site_id WHERE hashed_token=$1 AND expires_at>now() AND revoked_at IS NULL',
        [hashToken(token)],
      )
    ).rows[0];
    assert(row, 404, 'Link is invalid or expired');
    return row;
  }
  app.get(
    '/v1/portal/:token',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      schema: { tags: ['Portal'], params: z.object({ token: z.string().min(30).max(100) }) },
    },
    async (req) => {
      const token = await portal(req.params.token);
      assert(
        token.scopes.includes('read') || token.scopes.includes('request'),
        403,
        'Token lacks access',
      );
      let appointment = null;
      if (token.appointment_id) {
        assert(token.scopes.includes('read'), 403, 'Token lacks read access');
        const a = (
          await db.query('SELECT data FROM appointments WHERE id=$1 AND site_id=$2', [
            token.appointment_id,
            token.site_id,
          ])
        ).rows[0]?.data;
        const allocation = (
          await db.query(
            "SELECT start_at,end_at FROM dock_allocations WHERE appointment_id=$1 AND state='active'",
            [token.appointment_id],
          )
        ).rows[0];
        appointment = a
          ? {
              id: a.id,
              reference: a.reference,
              carrierName: a.carrierName,
              vehicle: a.vehicle,
              status: a.status,
              etaAt: a.etaAt,
              allocation,
            }
          : null;
      }
      return {
        site: {
          name: token.site.name,
          timezone: token.site.timezone,
          address: token.site.address,
          instructions: token.site.instructions,
        },
        appointment,
        canRequest: token.scopes.includes('request') && !token.used_at && !token.appointment_id,
      };
    },
  );
  app.post(
    '/v1/portal/:token/requests',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['Portal'],
        params: z.object({ token: z.string().min(30).max(100) }),
        body: appointmentFields.omit({
          siteId: true,
          carrierId: true,
          locked: true,
          relocationAllowed: true,
          priority: true,
          externalId: true,
        }),
      },
    },
    async (req) => {
      const token = await portal(req.params.token);
      assert(
        token.scopes.includes('request') && !token.used_at && !token.appointment_id,
        403,
        'This link cannot create another request',
      );
      const p: Principal = {
        id: token.id,
        organizationId: token.organization_id,
        source: 'integration',
        grants: [{ siteId: token.site_id, permissions: ['plan'] }],
      };
      return svc.mutate(
        p,
        token.site_id,
        'plan',
        'appointment.requested',
        token.id,
        async (s, c) => {
          const live = (
            await c.query(
              'SELECT * FROM portal_tokens WHERE id=$1 AND expires_at>now() AND revoked_at IS NULL FOR UPDATE',
              [token.id],
            )
          ).rows[0];
          assert(
            live && !live.used_at && !live.appointment_id,
            409,
            'Link already used or expired',
          );
          const a: Appointment = {
            ...appointmentInput.parse({ ...req.body, siteId: token.site_id }),
            id: uid('apt'),
            organizationId: token.organization_id,
            status: 'requested',
            version: 1,
            createdAt: new Date().toISOString(),
          };
          if (s.site.policy.portalAutoConfirm) {
            const { slots, reasons } = searchSlots(
              s,
              a,
              a.earliestStartAt,
              addMinutes(a.latestStartAt, a.durationMinutes),
            );
            assert(slots.length, 422, 'No available slot', reasons);
            a.status = 'confirmed';
            s.allocations.push({
              ...slots[0],
              id: uid('alloc'),
              appointmentId: a.id,
              planVersion: s.site.currentPlanVersion + 1,
            });
          }
          s.appointments.push(a);
          s.visits.push(newVisit(a.id));
          await c.query(
            "UPDATE portal_tokens SET used_at=now(),appointment_id=$2,scopes=ARRAY['read'] WHERE id=$1",
            [token.id, a.id],
          );
          return { reference: a.reference, status: a.status };
        },
      );
    },
  );
}
