# Validation

`npm run typecheck` checks server, domain, engine, database, worker, SDK and React. `npm run build` also builds Next.js. `npm test` executes engine/property tests and real PostgreSQL integration tests; an embedded development cluster is used only when `TEST_DATABASE_URL` is absent. Integration tests require a new empty database.

Coverage includes half-open intervals, compatibility, service transitions, operating hours, IANA spring/fall DST, deterministic output, immutable work, infeasibility, missing ETA, generated-plan invariants, exclusion constraints under concurrent writes, stale plan rollback, atomic approval, tenancy, RBAC, idempotent creation, carrier token scope/consumption, CSV rollback, append-only audit, and outbox retry/deduplication.

`npm run test:e2e` uses Playwright against a freshly seeded demo. Browser scenarios create/confirm a reservation, run its complete physical lifecycle, inject a delay, review/apply recovery, and use mobile navigation. Do not run repeatedly against an operational database: these tests intentionally create data and modify demo appointments.

`npm run benchmark` generates 200 appointments and 20 docks and prints hardware, Node version, duration and feasibility. It is a local engine measurement, not a production service-level promise. Calendar p95 under 20 concurrent readers and LAN SSE latency require a separately recorded load test; do not infer them from engine duration. Docker CI should be run before release on the target host architecture.
