import Fastify, { type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import {
  validatorCompiler,
  serializerCompiler,
  jsonSchemaTransform,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import argon2 from 'argon2';
import {
  assert,
  appointmentInput,
  appointmentChanges,
  dockInput,
  dockChanges,
  id,
  iso,
  replanInput,
  roleSchema,
  siteInput,
  violations,
  fixed,
  minutes,
  type Site,
  type Snapshot,
} from '@dockslot/domain';
import { event, pool, transaction, uid } from '@dockslot/db';
import { searchSlots } from '@dockslot/engine';
import {
  authenticate,
  authMode,
  localPrincipal,
  authorize,
  allowed,
  hashToken,
  secretToken,
  type Principal,
} from './security.js';
import { Service } from './service.js';
import { integrations } from './integrations.js';

declare module 'fastify' {
  interface FastifyRequest {
    principal: Principal;
  }
}
const paramsId = z.object({ id });
const siteQuery = z.object({ siteId: id });
const versionBody = z.object({ expectedPlanVersion: z.number().int().positive() });
export async function buildApp(db = pool) {
  const localMode = authMode() === 'local';
  const local = localMode ? localPrincipal() : null;
  const webOrigin = process.env.WEB_ORIGIN || 'http://localhost:3000';
  if (local)
    await db.query('INSERT INTO organizations(id,name) VALUES($1,$2) ON CONFLICT(id) DO NOTHING', [
      local.organizationId,
      'Local workspace',
    ]);
  const app = Fastify({
    logger:
      process.env.NODE_ENV === 'test'
        ? false
        : {
            redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers.set-cookie'],
            serializers: {
              req: (req: { method: string; url: string }) => ({
                method: req.method,
                path: req.url.split('?')[0].replace(/\/portal\/[^/]+/, '/portal/[redacted]'),
              }),
            },
          },
    bodyLimit: 2 * 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(cookie);
  await app.register(cors, {
    origin: process.env.WEB_ORIGIN || 'http://localhost:3000',
    credentials: true,
  });
  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'DockSlot API',
        version: '0.1.0',
        description:
          'Dock scheduling and human-approved recovery. All timestamps are ISO UTC. Conflicts return 409.',
      },
      components: {
        securitySchemes: {
          bearer: { type: 'http', scheme: 'bearer' },
          session: { type: 'apiKey', in: 'cookie', name: 'dockslot_session' },
        },
      },
      security: localMode ? [] : [{ bearer: [] }, { session: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });
  const svc = new Service(db);
  app.addHook('onRequest', async (req) => {
    const path = req.url.split('?')[0];
    // A local installation accepts the configured UI and CLI clients. Reject
    // other browser origins and DNS rebinding before any operational route.
    if (localMode) {
      const host = new URL(`http://${req.headers.host || 'localhost'}`).hostname;
      assert(
        ['localhost', '127.0.0.1', '[::1]', new URL(webOrigin).hostname].includes(host),
        403,
        'Invalid local host',
      );
      assert(
        !req.headers.origin || req.headers.origin === webOrigin,
        403,
        'Invalid request origin',
      );
      assert(
        req.headers['sec-fetch-site'] !== 'cross-site',
        403,
        'Cross-site requests are not allowed',
      );
      assert(
        !['/v1/auth/login', '/v1/auth/bootstrap'].includes(path),
        409,
        'Accounts are disabled in local mode',
      );
    }
    if (
      !path.startsWith('/v1/') ||
      [
        '/v1/auth/login',
        '/v1/auth/bootstrap',
        '/v1/openapi.json',
        '/v1/health/live',
        '/v1/health/ready',
      ].includes(path) ||
      path.startsWith('/v1/portal/')
    )
      return;
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/)?.[1],
      token = bearer || req.cookies.dockslot_session;
    assert(!req.headers.authorization || bearer, 401, 'Invalid authorization header');
    if (local && !bearer) {
      req.principal = local;
      return;
    }
    assert(token, 401, 'Authentication required');
    if (!bearer && !['GET', 'HEAD', 'OPTIONS'].includes(req.method))
      assert(
        req.headers.origin === (process.env.WEB_ORIGIN || 'http://localhost:3000'),
        403,
        'Invalid request origin',
      );
    const c = await db.connect();
    try {
      req.principal = await authenticate(
        c,
        token,
        bearer ? 'integration' : 'session',
        req.headers['x-organization-id'] as string | undefined,
      );
    } finally {
      c.release();
    }
  });
  app.setErrorHandler((error, req, reply) => {
    const e = error as Error & {
      statusCode?: number;
      code?: string;
      details?: unknown;
      validation?: unknown;
    };
    const conflict = ['23P01', '23505', '40001', '40P01'].includes(e.code || '');
    const status = conflict
      ? 409
      : e instanceof z.ZodError || e.validation
        ? 400
        : e.statusCode || 500;
    if (status >= 500) req.log.error({ err: e }, 'Request failed');
    reply.status(status).send({
      error: conflict
        ? 'Concurrent booking or duplicate external ID'
        : status >= 500
          ? 'Internal server error'
          : e.message,
      details: e.details || (e instanceof z.ZodError ? e.issues : undefined),
      requestId: req.id,
    });
  });
  app.get('/v1/health/live', { schema: { tags: ['Health'] } }, async () => ({ status: 'ok' }));
  app.get('/v1/health/ready', { schema: { tags: ['Health'] } }, async () => {
    await db.query('SELECT 1 FROM schema_migrations LIMIT 1');
    return { status: 'ready' };
  });
  app.get('/v1/openapi.json', { schema: { hide: true } }, async () => app.swagger());
  app.post(
    '/v1/auth/bootstrap',
    {
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
      schema: {
        tags: ['Auth'],
        body: z.object({
          organization: z.string().min(1).max(150),
          email: z.email(),
          password: z.string().min(12).max(200),
        }),
      },
    },
    async (req, reply) => {
      const result = await transaction(async (c) => {
        await c.query('SELECT pg_advisory_xact_lock(859343)');
        assert(
          !(await c.query('SELECT 1 FROM users LIMIT 1')).rowCount,
          409,
          'Instance is already initialized',
        );
        const orgId = uid('org'),
          userId = uid('user');
        await c.query('INSERT INTO organizations(id,name) VALUES($1,$2)', [
          orgId,
          req.body.organization,
        ]);
        await c.query('INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)', [
          userId,
          req.body.email.toLowerCase(),
          await argon2.hash(req.body.password, { type: argon2.argon2id }),
        ]);
        await c.query(
          "INSERT INTO memberships(id,organization_id,user_id,role) VALUES($1,$2,$3,'org_admin')",
          [uid('membership'), orgId, userId],
        );
        return { organizationId: orgId, userId };
      }, db);
      return reply.code(201).send(result);
    },
  );
  app.post(
    '/v1/auth/login',
    {
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
      schema: {
        tags: ['Auth'],
        body: z.object({ email: z.email(), password: z.string().min(1).max(200) }),
      },
    },
    async (req, reply) => {
      const user = (
        await db.query('SELECT * FROM users WHERE email=$1 AND active=true', [
          req.body.email.toLowerCase(),
        ])
      ).rows[0];
      assert(
        user && (await argon2.verify(user.password_hash, req.body.password)),
        401,
        'Invalid email or password',
      );
      const token = secretToken();
      await db.query(
        "INSERT INTO sessions(hashed_token,user_id,expires_at) VALUES($1,$2,now()+interval '12 hours')",
        [hashToken(token), user.id],
      );
      reply.setCookie('dockslot_session', token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.COOKIE_SECURE === 'true',
        path: '/',
        maxAge: 43200,
      });
      return { id: user.id, email: user.email };
    },
  );
  app.post('/v1/auth/logout', { schema: { tags: ['Auth'] } }, async (req, reply) => {
    await db.query('DELETE FROM sessions WHERE hashed_token=$1', [
      hashToken(req.cookies.dockslot_session || ''),
    ]);
    reply.clearCookie('dockslot_session', { path: '/' });
    return { ok: true };
  });
  app.get('/v1/auth/me', { schema: { tags: ['Auth'] } }, async (req) => ({
    localMode,
    ...req.principal,
    organizations:
      req.principal.source === 'session'
        ? (
            await db.query(
              'SELECT DISTINCT o.id,o.name FROM memberships m JOIN organizations o ON o.id=m.organization_id WHERE user_id=$1',
              [req.principal.id],
            )
          ).rows
        : [],
  }));
  app.get('/v1/sites', { schema: { tags: ['Sites'] } }, async (req) =>
    (
      await db.query(
        "SELECT data,current_plan_version FROM sites WHERE organization_id=$1 ORDER BY data->>'name'",
        [req.principal.organizationId],
      )
    ).rows
      .map((r) => ({ ...r.data, currentPlanVersion: r.current_plan_version }))
      .filter((s) => allowed(req.principal, 'read', s.id)),
  );
  app.post('/v1/sites', { schema: { tags: ['Sites'], body: siteInput } }, async (req, reply) => {
    authorize(req.principal, 'admin');
    const site: Site = {
      ...req.body,
      id: uid('site'),
      organizationId: req.principal.organizationId,
      currentPlanVersion: 1,
    };
    await transaction(async (c) => {
      await c.query('INSERT INTO sites(id,organization_id,data) VALUES($1,$2,$3)', [
        site.id,
        site.organizationId,
        site,
      ]);
      await event(c, {
        organizationId: site.organizationId,
        siteId: site.id,
        actor: req.principal.id,
        action: 'site.created',
        resourceId: site.id,
        after: site,
      });
    }, db);
    return reply.code(201).send(site);
  });
  app.get(
    '/v1/sites/:id',
    { schema: { tags: ['Sites'], params: paramsId } },
    async (req) => (await svc.read(req.principal, req.params.id)).site,
  );
  app.patch(
    '/v1/sites/:id',
    { schema: { tags: ['Sites'], params: paramsId, body: siteInput } },
    async (req) =>
      svc.mutate(req.principal, req.params.id, 'manage', 'site.updated', req.params.id, (s) => {
        Object.assign(s.site, req.body);
        return s.site;
      }),
  );
  app.get(
    '/v1/sites/:id/calendar',
    {
      schema: {
        tags: ['Calendar'],
        params: paramsId,
        querystring: z.object({ from: iso.optional(), to: iso.optional() }),
      },
    },
    async (req) => {
      const s = await svc.read(req.principal, req.params.id);
      const conflicts = s.allocations.flatMap((x) => {
        const a = s.appointments.find((a) => a.id === x.appointmentId)!;
        if (['fulfilled', 'cancelled', 'no_show'].includes(a.status)) return [];
        const reasons = violations(
          s,
          a,
          x,
          s.allocations,
          fixed(
            a,
            s.visits.find((v) => v.appointmentId === a.id),
          ),
        );
        return reasons.length ? [{ appointmentId: a.id, reasons }] : [];
      });
      if (req.query.from || req.query.to) {
        const from = req.query.from || '0000',
          to = req.query.to || '9999';
        assert(from < to, 400, 'Calendar end must follow start');
        s.appointments = s.appointments.filter((a) => {
          const x = s.allocations.find((x) => x.appointmentId === a.id);
          return x
            ? x.endAt > from && x.startAt < to
            : a.latestStartAt >= from && a.earliestStartAt < to;
        });
        const ids = new Set(s.appointments.map((a) => a.id));
        s.allocations = s.allocations.filter((a) => ids.has(a.appointmentId));
        s.visits = s.visits.filter((v) => ids.has(v.appointmentId));
        s.blocks = s.blocks.filter((b) => b.endAt > from && b.startAt < to);
        return { ...s, conflicts: conflicts.filter((c) => ids.has(c.appointmentId)) };
      }
      return { ...s, conflicts };
    },
  );
  app.get(
    '/v1/sites/:id/docks',
    { schema: { tags: ['Docks'], params: paramsId } },
    async (req) => (await svc.read(req.principal, req.params.id)).docks,
  );
  app.post(
    '/v1/sites/:id/docks',
    { schema: { tags: ['Docks'], params: paramsId, body: dockInput } },
    async (req) =>
      svc.mutate(req.principal, req.params.id, 'manage', 'dock.created', req.params.id, (s) => {
        assert(!s.docks.some((d) => d.code === req.body.code), 409, 'Dock code already exists');
        const d = { ...req.body, id: uid('dock'), siteId: s.site.id };
        s.docks.push(d);
        return d;
      }),
  );
  app.patch(
    '/v1/docks/:id',
    { schema: { tags: ['Docks'], params: paramsId, body: dockChanges } },
    async (req) =>
      svc.mutate(
        req.principal,
        await svc.dockSite(req.principal, req.params.id),
        'manage',
        'dock.updated',
        req.params.id,
        (s) => {
          const d = s.docks.find((d) => d.id === req.params.id)!;
          Object.assign(d, req.body);
          return d;
        },
      ),
  );
  app.post(
    '/v1/docks/:id/blocks',
    {
      schema: {
        tags: ['Docks'],
        params: paramsId,
        body: z
          .object({ startAt: iso, endAt: iso, reason: z.string().min(3).max(1000) })
          .refine((v) => v.endAt > v.startAt, 'End must follow start'),
      },
    },
    async (req) =>
      svc.mutate(
        req.principal,
        await svc.dockSite(req.principal, req.params.id),
        allowed(req.principal, 'manage', await svc.dockSite(req.principal, req.params.id))
          ? 'manage'
          : 'dock',
        'dock.blocked',
        req.params.id,
        (s) => {
          const b = { ...req.body, id: uid('block'), dockId: req.params.id };
          s.blocks.push(b);
          return b;
        },
      ),
  );
  app.delete(
    '/v1/docks/:id/blocks/:blockId',
    { schema: { tags: ['Docks'], params: z.object({ id, blockId: id }) } },
    async (req) =>
      svc.mutate(
        req.principal,
        await svc.dockSite(req.principal, req.params.id),
        'manage',
        'dock.unblocked',
        req.params.blockId,
        (s) => {
          assert(
            s.blocks.some((b) => b.id === req.params.blockId && b.dockId === req.params.id),
            404,
            'Block not found',
          );
          s.blocks = s.blocks.filter((b) => b.id !== req.params.blockId);
          return { ok: true };
        },
      ),
  );
  app.post(
    '/v1/appointments',
    { schema: { tags: ['Appointments'], body: appointmentInput } },
    async (req, reply) =>
      reply
        .code(201)
        .send(
          await svc.create(
            req.principal,
            req.body,
            req.headers['idempotency-key'] as string | undefined,
          ),
        ),
  );
  app.get(
    '/v1/appointments',
    { schema: { tags: ['Appointments'], querystring: siteQuery } },
    async (req) => (await svc.read(req.principal, req.query.siteId)).appointments,
  );
  app.get(
    '/v1/appointments/:id',
    { schema: { tags: ['Appointments'], params: paramsId } },
    async (req) => {
      const s = await svc.read(
        req.principal,
        await svc.appointmentSite(req.principal, req.params.id),
      );
      return {
        ...s.appointments.find((a) => a.id === req.params.id),
        allocation: s.allocations.find((a) => a.appointmentId === req.params.id) || null,
        visit: s.visits.find((v) => v.appointmentId === req.params.id),
      };
    },
  );
  app.patch(
    '/v1/appointments/:id',
    {
      schema: {
        tags: ['Appointments'],
        params: paramsId,
        body: z.object({
          expectedVersion: z.number().int().positive(),
          changes: appointmentChanges,
        }),
      },
    },
    async (req) =>
      svc.update(req.principal, req.params.id, req.body.changes, req.body.expectedVersion),
  );
  app.post(
    '/v1/appointments/:id/confirm',
    {
      schema: {
        tags: ['Appointments'],
        params: paramsId,
        body: versionBody.extend({ dockId: id, startAt: iso }),
      },
    },
    async (req) =>
      svc.confirm(req.principal, req.params.id, req.body, req.body.expectedPlanVersion),
  );
  for (const action of ['cancel', 'mark-no-show'] as const)
    app.post(
      `/v1/appointments/:id/${action}`,
      {
        schema: {
          tags: ['Appointments'],
          params: paramsId,
          body: z.object({ reason: z.string().min(3).max(1000) }),
        },
      },
      async (req) =>
        svc.cancel(req.principal, req.params.id, req.body.reason, action === 'mark-no-show'),
    );
  app.post(
    '/v1/appointments/:id/eta',
    { schema: { tags: ['Appointments'], params: paramsId, body: z.object({ etaAt: iso }) } },
    async (req) => svc.eta(req.principal, req.params.id, req.body.etaAt),
  );
  app.get(
    '/v1/appointments/:id/history',
    { schema: { tags: ['Appointments'], params: paramsId } },
    async (req) => {
      await svc.appointmentSite(req.principal, req.params.id);
      return (
        await db.query(
          'SELECT id,actor,action,source,created_at FROM audit_events WHERE organization_id=$1 AND resource_id=$2 ORDER BY id DESC LIMIT 200',
          [req.principal.organizationId, req.params.id],
        )
      ).rows;
    },
  );
  for (const action of ['check-in', 'start-service', 'complete-service', 'check-out'])
    app.post(
      `/v1/appointments/:id/${action}`,
      { schema: { tags: ['Visits'], params: paramsId } },
      async (req) => svc.visit(req.principal, req.params.id, action),
    );
  app.post(
    '/v1/availability/search',
    {
      schema: {
        tags: ['Calendar'],
        body: z
          .object({ appointmentId: id, startAt: iso, endAt: iso })
          .refine(
            (v) =>
              Date.parse(v.endAt) > Date.parse(v.startAt) &&
              Date.parse(v.endAt) - Date.parse(v.startAt) <= 7 * 86400000,
            'Search horizon must be between zero and seven days',
          ),
      },
    },
    async (req) => {
      const s = await svc.read(
        req.principal,
        await svc.appointmentSite(req.principal, req.body.appointmentId),
      );
      const result = searchSlots(
        s,
        s.appointments.find((a) => a.id === req.body.appointmentId)!,
        req.body.startAt,
        req.body.endAt,
      );
      return { ...result, planVersion: s.site.currentPlanVersion };
    },
  );
  app.post(
    '/v1/sites/:id/replans',
    { schema: { tags: ['Recovery'], params: paramsId, body: replanInput } },
    async (req) => svc.propose(req.principal, req.params.id, req.body),
  );
  app.get('/v1/replans/:id', { schema: { tags: ['Recovery'], params: paramsId } }, async (req) => {
    const row = await svc.proposal(req.principal, req.params.id);
    return { ...row.proposal_json, status: row.status };
  });
  app.post(
    '/v1/replans/:id/apply',
    { schema: { tags: ['Recovery'], params: paramsId, body: versionBody } },
    async (req) => svc.apply(req.principal, req.params.id, req.body.expectedPlanVersion),
  );
  app.post(
    '/v1/replans/:id/reject',
    { schema: { tags: ['Recovery'], params: paramsId } },
    async (req) => {
      const row = await svc.proposal(req.principal, req.params.id);
      authorize(req.principal, 'plan', row.site_id);
      return transaction(async (c) => {
        const updated = await c.query(
          "UPDATE replan_proposals SET status='rejected' WHERE id=$1 AND status='pending' RETURNING id",
          [req.params.id],
        );
        assert(updated.rowCount, 409, 'Proposal already resolved');
        await event(c, {
          organizationId: req.principal.organizationId,
          siteId: row.site_id,
          actor: req.principal.id,
          action: 'replan.rejected',
          resourceId: row.id,
        });
        return { status: 'rejected' };
      }, db);
    },
  );
  app.get(
    '/v1/sites/:id/metrics',
    { schema: { tags: ['Metrics'], params: paramsId } },
    async (req) => {
      const s = await svc.read(req.principal, req.params.id),
        arrived = s.visits.filter((v) => v.checkedInAt),
        started = s.visits.filter((v) => v.checkedInAt && v.serviceStartedAt),
        completed = s.visits.filter((v) => v.serviceStartedAt && v.serviceCompletedAt);
      return {
        samples: { arrivals: arrived.length, waiting: started.length, service: completed.length },
        averageWaitingMinutes: started.length
          ? started.reduce((n, v) => n + minutes(v.serviceStartedAt!, v.checkedInAt!), 0) /
            started.length
          : null,
        averageServiceMinutes: completed.length
          ? completed.reduce((n, v) => n + minutes(v.serviceCompletedAt!, v.serviceStartedAt!), 0) /
            completed.length
          : null,
        onTimeArrivalPercent: arrived.length
          ? (100 *
              arrived.filter((v) => {
                const a = s.allocations.find((a) => a.appointmentId === v.appointmentId);
                return a && minutes(v.checkedInAt!, a.startAt) <= s.site.policy.toleranceMinutes;
              }).length) /
            arrived.length
          : null,
        docks: s.docks.map((d) => ({
          id: d.id,
          code: d.code,
          plannedMinutes: s.allocations
            .filter((a) => a.dockId === d.id)
            .reduce((n, a) => n + minutes(a.endAt, a.startAt), 0),
        })),
      };
    },
  );
  app.get(
    '/v1/audit-events',
    { schema: { tags: ['Audit'], querystring: siteQuery } },
    async (req) => {
      await svc.read(req.principal, req.query.siteId);
      return (
        await db.query(
          'SELECT id,actor,source,action,resource_id,created_at FROM audit_events WHERE organization_id=$1 AND site_id=$2 ORDER BY id DESC LIMIT 200',
          [req.principal.organizationId, req.query.siteId],
        )
      ).rows;
    },
  );
  app.get(
    '/v1/events/stream',
    { schema: { tags: ['Events'], querystring: siteQuery } },
    async (req, reply) => {
      await svc.read(req.principal, req.query.siteId);
      const cursorHeader = String(req.headers['last-event-id'] || '0');
      assert(/^\d{1,18}$/.test(cursorHeader), 400, 'Invalid event cursor');
      let cursor = cursorHeader,
        busy = false;
      reply.hijack();
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      });
      reply.raw.write('retry: 2000\n\n');
      const tick = async () => {
        if (busy || reply.raw.destroyed) return;
        busy = true;
        try {
          const rows = (
            await db.query(
              'SELECT id,name,created_at FROM outbox_events WHERE organization_id=$1 AND site_id=$2 AND id>$3 ORDER BY id LIMIT 100',
              [req.principal.organizationId, req.query.siteId, cursor],
            )
          ).rows;
          for (const row of rows) {
            reply.raw.write(`id: ${row.id}\ndata: ${JSON.stringify(row)}\n\n`);
            cursor = row.id;
          }
          if (!rows.length) reply.raw.write(': heartbeat\n\n');
        } catch {
          reply.raw.end();
        } finally {
          busy = false;
        }
      };
      const timer = setInterval(() => void tick(), 1000),
        expiry = setTimeout(() => reply.raw.end(), 5 * 60 * 1000);
      reply.raw.on('close', () => {
        clearInterval(timer);
        clearTimeout(expiry);
      });
      void tick();
    },
  );
  await integrations(app, svc, db);
  return app;
}
