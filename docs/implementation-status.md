# Implementation status

This initial release covers the core MVP workflows; P1 and P2 items are planned for future versions.

| Area | Implemented | Limits / follow-up |
|---|---|---|
| Persistence | PostgreSQL migration, relational ownership, active-overlap exclusion, allocation history, plan versions, audit/outbox | Typed entity details use JSONB; no RLS; direct SQL writers must follow the documented site locking protocol |
| Auth/RBAC | Argon2id, cookie sessions, org/site roles, scoped expiring tokens, membership revocation | No SSO, MFA, password reset email, invitation email, or account recovery UI |
| Configuration | Multiple sites, IANA zones, daily operating hours, weekdays, holidays, dock types/tags/dimensions, dock blocks | One daily shift window; formal per-booking calendar exceptions and complex shift calendars are not implemented |
| Booking | Requests, confirmation, editing, moves, locks, ETA, cancellation/no-show, availability, external IDs | Arrival cancellations require operational review; no administrative event correction UI yet |
| Operations | Separate appointment/visit states, server-time check-in/service/checkout, physical occupied-dock checks | Automatic overrun detection/reservation extension and offline capture are not implemented |
| Board | Day timeline, week list, search/filter, drag suggestion + confirmation, slot picker, SSE | Follows configured daily shift window; orientation is not configurable; Portuguese navigation only |
| Recovery | Deterministic candidate search, normalized cost, fairness ordering, reinsertion, immutable proposals, approval/rejection, stale conflict protection | No optimality guarantee, global solver, relaxed-constraint exception mode, or full scenario comparison UI |
| Carrier portal | Expiring scoped lookup/request token, one request per link, optional auto-confirm | No email delivery, carrier accounts, reschedule negotiation, or public availability calendar |
| Integrations | REST/OpenAPI, CSV preview/atomic commit/export, hashed tokens, signed encrypted webhooks, retries/history | Idempotency-Key on appointment creation only; SDK is source-only; no integration catalog |
| Metrics | Recorded waiting/service/arrival metrics and allocated workload | Loaded-schedule aggregate, not a full date-filtered analytics warehouse; no Prometheus exporter yet |
| OSS delivery | Apache-2.0, contributor/security docs, CI, Docker setup, examples, tests | No remote repository, release, package publication, or independent security audit has been performed yet |

See [testing](operations/testing.md) for the checks executed on this release.
