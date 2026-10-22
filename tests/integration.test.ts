import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { DevelopmentPostgres as EmbeddedPostgres } from '../scripts/development-postgres.js';
import pg from 'pg';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { buildApp } from '../apps/api/src/app.js';
import { migrate, persist, snapshot, transaction, uid } from '@dockslot/db';
import { hashToken, encrypt } from '../apps/api/src/security.js';
import { tick } from '../apps/worker/src/main.js';
import { fixture, request } from './fixtures.js';
import { type Snapshot } from '@dockslot/domain';
let postgres: EmbeddedPostgres | undefined,
  db: pg.Pool,
  app: Awaited<ReturnType<typeof buildApp>>,
  s: Snapshot;
const token = 'test-admin-token-with-enough-entropy',
  headers = { authorization: `Bearer ${token}` };
async function call(method: any, url: string, payload?: unknown, custom = headers) {
  return app.inject({ method, url, headers: custom, payload: payload as any });
}
async function calendar() {
  return (await call('GET', `/v1/sites/${s.site.id}/calendar`)).json();
}
async function create(extra: Record<string, unknown> = {}) {
  const r = await call('POST', '/v1/appointments', {
    siteId: s.site.id,
    carrierName: 'Test Carrier',
    reference: uid('PO'),
    operationType: 'inbound',
    etaAt: request.startAt,
    earliestStartAt: request.startAt,
    latestStartAt: '2026-11-04T23:00:00.000Z',
    durationMinutes: 60,
    ...extra,
  });
  expect(r.statusCode, r.body).toBe(201);
  return r.json();
}
beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.AUTH_MODE = 'session';
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
  if (!process.env.TEST_DATABASE_URL) {
    mkdirSync(resolve('.local'), { recursive: true });
    postgres = new EmbeddedPostgres({
      databaseDir: resolve(`.local/test-postgres-${process.pid}`),
      user: 'test',
      password: 'test',
      port: 55433,
      persistent: true,
      initdbFlags: ['--encoding=UTF8', '--locale=C', '--no-sync'],
      postgresFlags: ['-h', '127.0.0.1'],
      onLog: () => {},
      onError: () => {},
    });
    await postgres.initialise();
    await postgres.start();
    await postgres.createDatabase('dockslot_test');
  }
  db = new pg.Pool({
    connectionString:
      process.env.TEST_DATABASE_URL || 'postgres://test:test@127.0.0.1:55433/dockslot_test',
  });
  await migrate(db);
  await migrate(db);
  await db.query(
    "INSERT INTO organizations(id,name) VALUES('org_test','Test'),('org_other','Other')",
  );
  await db.query(
    "INSERT INTO api_tokens(id,organization_id,name,hashed_token,scopes,expires_at) VALUES('token_test','org_test','Test',$1,ARRAY['read','plan','gate','dock','manage','admin'],now()+interval '1 day')",
    [hashToken(token)],
  );
  app = await buildApp(db);
  await app.ready();
});
beforeEach(async () => {
  s = fixture(0, 2);
  s.site.id = uid('site');
  s.docks.forEach((d) => {
    d.id = uid('dock');
    d.siteId = s.site.id;
  });
  await transaction(async (c) => {
    await c.query('INSERT INTO sites(id,organization_id,data) VALUES($1,$2,$3)', [
      s.site.id,
      s.site.organizationId,
      s.site,
    ]);
    await persist(c, { ...s, docks: [] }, s, 'test');
  }, db);
});
afterAll(async () => {
  await app?.close();
  await db?.end();
  await postgres?.stop();
});
describe('PostgreSQL API invariants', () => {
  it('opens a local workspace without accounts and isolates its organization', async () => {
    process.env.AUTH_MODE = 'local';
    process.env.LOCAL_ORGANIZATION_ID = 'org_local_test';
    const usersBefore = (await db.query('SELECT count(*) FROM users')).rows[0].count;
    const localApp = await buildApp(db);
    try {
      const me = await localApp.inject({ method: 'GET', url: '/v1/auth/me' });
      expect(me.statusCode).toBe(200);
      expect(me.json()).toMatchObject({
        localMode: true,
        source: 'local',
        organizationId: 'org_local_test',
      });
      expect(me.headers['set-cookie']).toBeUndefined();
      expect((await localApp.inject({ method: 'GET', url: '/v1/sites' })).json()).toEqual([]);
      const site = await localApp.inject({
        method: 'POST',
        url: '/v1/sites',
        headers: { origin: 'http://localhost:3000' },
        payload: { name: 'My warehouse', timezone: 'America/Sao_Paulo' },
      });
      expect(site.statusCode, site.body).toBe(201);
      expect(site.json().organizationId).toBe('org_local_test');
      expect(
        (await localApp.inject({ method: 'GET', url: `/v1/sites/${s.site.id}/calendar` }))
          .statusCode,
      ).toBe(404);
      expect((await db.query('SELECT count(*) FROM users')).rows[0].count).toBe(usersBefore);
      // Explicit credentials never fall back to unrestricted local access.
      expect(
        (
          await localApp.inject({
            method: 'GET',
            url: '/v1/sites',
            headers: { authorization: 'Bearer invalid' },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await localApp.inject({
            method: 'GET',
            url: '/v1/sites',
            headers: { authorization: 'Basic invalid' },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (await localApp.inject({ method: 'GET', url: '/v1/auth/me', headers })).json().source,
      ).toBe('integration');
      for (const bad of [
        { origin: 'https://other.example' },
        { host: 'rebind.example:4000' },
        { 'sec-fetch-site': 'cross-site' },
      ]) {
        expect(
          (await localApp.inject({ method: 'GET', url: '/v1/sites', headers: bad })).statusCode,
        ).toBe(403);
        expect(
          (
            await localApp.inject({
              method: 'POST',
              url: '/v1/sites',
              headers: bad,
              payload: { name: 'Blocked', timezone: 'UTC' },
            })
          ).statusCode,
        ).toBe(403);
      }
      expect(
        (await localApp.inject({ method: 'POST', url: '/v1/auth/bootstrap', payload: {} }))
          .statusCode,
      ).toBe(409);
    } finally {
      await localApp.close();
      process.env.AUTH_MODE = 'session';
      delete process.env.LOCAL_ORGANIZATION_ID;
    }
  });
  it('publishes OpenAPI and health checks', async () => {
    expect((await call('GET', '/v1/health/ready')).statusCode).toBe(200);
    const r = await call('GET', '/v1/openapi.json');
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json().paths['/v1/sites/{id}/replans']).toBeDefined();
  });
  it('creates and executes the full visit lifecycle with audit and outbox', async () => {
    const a = await create();
    let r = await call('POST', `/v1/appointments/${a.id}/start-service`, {});
    expect(r.statusCode).toBe(409);
    r = await call('POST', `/v1/appointments/${a.id}/confirm`, {
      dockId: s.docks[0].id,
      startAt: request.startAt,
      expectedPlanVersion: (await calendar()).site.currentPlanVersion,
    });
    expect(r.statusCode, r.body).toBe(200);
    for (const action of ['check-in', 'start-service', 'complete-service', 'check-out']) {
      const r = await call('POST', `/v1/appointments/${a.id}/${action}`, {});
      expect(r.statusCode, r.body).toBe(200);
    }
    const c = await calendar();
    expect(c.visits[0].status).toBe('checked_out');
    expect(c.appointments[0].status).toBe('fulfilled');
    const events = (
      await db.query('SELECT name FROM outbox_events WHERE site_id=$1', [s.site.id])
    ).rows.map((r) => r.name);
    expect(events).toContain('visit.checked_out');
    expect(
      (await db.query('SELECT * FROM audit_events WHERE site_id=$1', [s.site.id])).rowCount,
    ).toBeGreaterThan(5);
  });
  it('allows only one concurrent booking and returns 409 for the loser', async () => {
    const a = await create(),
      b = await create(),
      version = (await calendar()).site.currentPlanVersion;
    const results = await Promise.all(
      [a, b].map((a) =>
        call('POST', `/v1/appointments/${a.id}/confirm`, {
          dockId: s.docks[0].id,
          startAt: request.startAt,
          expectedPlanVersion: version,
        }),
      ),
    );
    expect(results.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    expect((await calendar()).allocations).toHaveLength(1);
  });
  it('PostgreSQL exclusion independently rejects a concurrent overlap', async () => {
    const a = await create(),
      b = await create();
    const results = await Promise.allSettled(
      [a, b].map((a) =>
        transaction(async (c) => {
          await c.query(
            "INSERT INTO dock_allocations(id,appointment_id,dock_id,site_id,start_at,end_at,state,plan_version) VALUES($1,$2,$3,$4,$5,$6,'active',1)",
            [uid('alloc'), a.id, s.docks[0].id, s.site.id, request.startAt, '2026-11-04T13:00:00Z'],
          );
        }, db),
      ),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect(
      (results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.code,
    ).toBe('23P01');
  });
  it('rejects a stale recovery proposal without partial writes', async () => {
    const a = await create();
    const generated = await call('POST', `/v1/sites/${s.site.id}/replans`, request);
    expect(generated.statusCode, generated.body).toBe(200);
    const proposal = generated.json();
    await call('POST', `/v1/appointments/${a.id}/eta`, { etaAt: '2026-11-04T15:00:00Z' });
    const before = await calendar();
    const applied = await call('POST', `/v1/replans/${proposal.id}/apply`, {
      expectedPlanVersion: proposal.baselinePlanVersion,
    });
    expect(applied.statusCode, applied.body).toBe(409);
    expect((await calendar()).allocations).toEqual(before.allocations);
    expect((await calendar()).site.currentPlanVersion).toBe(before.site.currentPlanVersion);
  });
  it('recalculates and atomically applies an unchanged proposal once', async () => {
    await create();
    const proposal = (await call('POST', `/v1/sites/${s.site.id}/replans`, request)).json();
    expect(proposal.applicable).toBe(true);
    expect((await calendar()).allocations).toHaveLength(0);
    const applied = await call('POST', `/v1/replans/${proposal.id}/apply`, {
      expectedPlanVersion: proposal.baselinePlanVersion,
    });
    expect(applied.statusCode, applied.body).toBe(200);
    expect((await calendar()).allocations).toHaveLength(1);
    expect(
      (
        await call('POST', `/v1/replans/${proposal.id}/apply`, {
          expectedPlanVersion: proposal.baselinePlanVersion,
        })
      ).statusCode,
    ).toBe(409);
  });
  it('enforces tenant and site-scoped RBAC', async () => {
    const a = await create();
    await db.query(
      "INSERT INTO api_tokens(id,organization_id,site_id,name,hashed_token,scopes,expires_at) VALUES($1,'org_other',NULL,'Other',$2,ARRAY['read','plan'],now()+interval '1 day'),($3,'org_test',$4,'Viewer',$5,ARRAY['read'],now()+interval '1 day')",
      [uid('token'), hashToken('other'), uid('token'), s.site.id, hashToken('viewer')],
    );
    expect(
      (await call('GET', `/v1/appointments/${a.id}`, undefined, { authorization: 'Bearer other' }))
        .statusCode,
    ).toBe(404);
    expect(
      (
        await call('GET', `/v1/sites/${s.site.id}/calendar`, undefined, {
          authorization: 'Bearer other',
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await call(
          'POST',
          `/v1/appointments/${a.id}/eta`,
          { etaAt: request.startAt },
          { authorization: 'Bearer viewer' },
        )
      ).statusCode,
    ).toBe(403);
  });
  it('replays an idempotent write and rejects reuse with other input', async () => {
    const input = {
      siteId: s.site.id,
      carrierName: 'C',
      reference: 'IDEMPOTENT',
      operationType: 'inbound',
      earliestStartAt: request.startAt,
      latestStartAt: '2026-11-04T23:00:00Z',
      durationMinutes: 60,
    };
    const h = { ...headers, 'idempotency-key': uid('key') };
    const a = await call('POST', '/v1/appointments', input, h),
      b = await call('POST', '/v1/appointments', input, h);
    expect(a.json().id).toBe(b.json().id);
    expect(
      (await call('POST', '/v1/appointments', { ...input, reference: 'DIFFERENT' }, h)).statusCode,
    ).toBe(409);
  });
  it('rejects invalid CSV atomically and handles duplicates', async () => {
    const csv =
      'reference,carrierName,operationType,earliestStartAt,latestStartAt,durationMinutes\nCSV-1,Carrier,inbound,2026-11-04T12:00:00Z,2026-11-04T18:00:00Z,60\nCSV-1,Carrier,inbound,2026-11-04T12:00:00Z,2026-11-04T18:00:00Z,60';
    const preview = (
      await call('POST', '/v1/imports/appointments/preview', { siteId: s.site.id, csv })
    ).json();
    expect(preview.errors).toHaveLength(1);
    const commit = await call('POST', '/v1/imports/appointments/commit', {
      siteId: s.site.id,
      csv,
      expectedPlanVersion: preview.planVersion,
    });
    expect(commit.statusCode).toBe(400);
    expect((await calendar()).appointments).toHaveLength(0);
    const wrong = (
      await call('POST', '/v1/imports/appointments/preview', {
        siteId: s.site.id,
        csv: 'unknown\nvalue',
      })
    ).json();
    expect(wrong.errors.length).toBeGreaterThan(0);
  });
  it('grants portal access only to its appointment and consumes request tokens once', async () => {
    const a = await create({ reference: 'PRIVATE-A' });
    const link = (
      await call('POST', '/v1/portal-tokens', {
        siteId: s.site.id,
        appointmentId: a.id,
        scopes: ['read'],
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      })
    ).json();
    const visible = await call('GET', `/v1/portal/${link.token}`, undefined, {} as any);
    expect(visible.statusCode, visible.body).toBe(200);
    expect(visible.json().appointment.reference).toBe('PRIVATE-A');
    expect(visible.json().appointments).toBeUndefined();
    expect((await call('GET', `/v1/appointments/${a.id}`, undefined, {} as any)).statusCode).toBe(
      401,
    );
    const requestLink = (
      await call('POST', '/v1/portal-tokens', {
        siteId: s.site.id,
        scopes: ['read', 'request'],
        expiresAt: new Date(Date.now() + 86400000).toISOString(),
      })
    ).json();
    const input = {
      carrierName: 'External',
      reference: 'PORTAL',
      operationType: 'inbound',
      earliestStartAt: request.startAt,
      latestStartAt: '2026-11-04T23:00:00Z',
      durationMinutes: 60,
    };
    const submitted = await call(
      'POST',
      `/v1/portal/${requestLink.token}/requests`,
      input,
      {} as any,
    );
    expect(submitted.statusCode, submitted.body).toBe(200);
    expect(
      (await call('POST', `/v1/portal/${requestLink.token}/requests`, input, {} as any)).statusCode,
    ).toBe(403);
    expect(
      (await call('GET', `/v1/portal/${requestLink.token}`, undefined, {} as any)).json()
        .appointment.reference,
    ).toBe('PORTAL');
  });
  it('protects append-only audit rows at the database layer', async () => {
    await create();
    await expect(
      db.query('DELETE FROM audit_events WHERE site_id=$1', [s.site.id]),
    ).rejects.toMatchObject({ message: 'audit_events is append-only' });
  });
  it('delivers outbox at least once with retries and deduplicated delivery rows', async () => {
    const webhookId = uid('wh');
    await db.query(
      'INSERT INTO webhook_endpoints(id,organization_id,url,encrypted_secret,event_filters) VALUES($1,$2,$3,$4,$5)',
      [
        webhookId,
        'org_test',
        'https://example.com/events',
        encrypt('secret'),
        ['appointment.requested'],
      ],
    );
    await create();
    let calls = 0;
    const fail = async () => {
      calls++;
      return 500;
    };
    await tick(db, fail);
    await tick(db, fail);
    const row = (
      await db.query(
        'SELECT * FROM webhook_deliveries WHERE endpoint_id=$1 ORDER BY id DESC LIMIT 1',
        [webhookId],
      )
    ).rows[0];
    expect(row).toBeDefined();
    expect(row.attempt).toBeGreaterThanOrEqual(0);
    await db.query('UPDATE webhook_deliveries SET next_attempt_at=now() WHERE endpoint_id=$1', [
      webhookId,
    ]);
    for (let i = 0; i < 30; i++) await tick(db, async () => 200);
    const duplicate = await db.query(
      'SELECT event_id,endpoint_id,count(*) FROM webhook_deliveries GROUP BY event_id,endpoint_id HAVING count(*)>1',
    );
    expect(duplicate.rowCount).toBe(0);
    expect(
      (await db.query('SELECT status FROM webhook_deliveries WHERE id=$1', [row.id])).rows[0]
        .status,
    ).toBe('delivered');
    expect(calls).toBeGreaterThan(0);
  });
});
