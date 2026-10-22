# API and permissions

The running API serves authoritative OpenAPI at `/v1/openapi.json` and interactive Swagger UI at `/docs`. Successful calls return JSON except CSV export and SSE. Validation errors are 400, missing credentials 401, missing permissions 403, inaccessible resources 404, stale versions/overlaps 409, infeasible applications 422, and rate limits 429. Errors contain `error`, optional `details`, and `requestId`.

## Authentication

The default `AUTH_MODE=local` requires no credentials: requests act as the local operator within the configured local organization. The UI needs no account or session cookie. Foreign Origin/Host and cross-site browser requests are rejected. Bearer tokens, when supplied, still enforce their expiry and permissions. Account bootstrap/login are disabled in this mode. All role and session rules below apply to the optional `AUTH_MODE=session` shared deployment.

Humans sign in through `POST /v1/auth/login` and receive a 12-hour HttpOnly SameSite=Lax cookie. Cookie-authenticated mutations require the configured `WEB_ORIGIN` Origin header. Use `COOKIE_SECURE=true` under TLS. The first local administrator is initialized with `POST /v1/auth/bootstrap`; it is permanently closed once any user exists. Multi-organization sessions can select an authorized organization with `X-Organization-Id`.

Integration clients use `Authorization: Bearer <token>`. Create/revoke tokens through Settings or `/v1/integrations/tokens`. Tokens have explicit expiry, optional site scope, and a subset of `read`, `plan`, `gate`, `dock`, `manage`. Tokens cannot create other administrator tokens. Include `read` together with command scopes because resource discovery is authorized separately. Organization-wide administration is reserved for human org admins.

| Role | Read | Plan/recovery | Gate | Dock service/block | Facility management | Members/integrations |
|---|---|---|---|---|---|---|
| Org admin | yes | yes | yes | yes | yes | yes |
| Site manager | yes | yes | yes | yes | yes | no |
| Planner | yes | yes | no | no | no | no |
| Gate operator | yes | no | yes | no | no | no |
| Dock operator | yes | no | no | yes | no | no |
| Viewer | yes | no | no | no | no | no |

Unlocking a manual lock requires facility management permission. Site grants restrict every action to that site; organization grants cover all sites in the selected organization.

## Booking and recovery

```sh
curl http://localhost:4000/v1/appointments \
  -H "Authorization: Bearer $DOCKSLOT_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: purchase-order-9044' \
  -d '{"siteId":"site_demo","carrierName":"Example Freight","reference":"PO-9044","operationType":"inbound","etaAt":"2026-11-04T12:00:00Z","earliestStartAt":"2026-11-04T12:00:00Z","latestStartAt":"2026-11-04T18:00:00Z","durationMinutes":60,"requiredCapabilities":["reefer"]}'
```

`carrierName` is required in this implementation; `carrierId` can carry an integration reference. `Idempotency-Key` is implemented for appointment creation and scoped to organization plus actor. A replay returns the first result; different input with the same key returns 409. `externalId` is unique across the organization. Other writes use state/version preconditions and are not claimed to support generic idempotency keys.

Search with `POST /availability/search` using `appointmentId`, `startAt`, `endAt` (maximum 7 days). Confirm/move with `POST /appointments/:id/confirm` using `dockId`, `startAt`, `expectedPlanVersion`. Appointment edits use `{ "expectedVersion": 1, "changes": { ... } }`; ETA is a separate eventful command and may flag the existing allocation as conflicted.

Generate with `POST /sites/:id/replans` and `{startAt,endAt,reason,overrides?}`. An override can pin work or update a movable ETA; it cannot unlock manual locks. Generation does not modify the schedule. Apply with `POST /replans/:id/apply` and `{expectedPlanVersion}`. The body version is authoritative; an `If-Match` header is not currently parsed. Any intervening operational edit requires regeneration.

## Carrier links

`POST /portal-tokens` accepts `siteId`, optional `appointmentId`, scopes (`read`, `request`) and expiry within 30 days. A request token can create one appointment; it is then bound to that appointment with read-only scope. Expired/revoked links return 404. `/portal/:token` never returns other carriers' bookings. Tokens must be shared privately. Carrier reschedule negotiations are not implemented; carriers contact the site.

## CSV

Use `POST /imports/appointments/preview` with `{siteId,csv}`. Unknown/duplicate columns, duplicate references/external IDs, invalid rows, and conflicts are reported. Commit the same CSV with the returned `expectedPlanVersion`; the whole batch is revalidated under the site lock. Any row/database conflict rolls back every row. Supply `dockId,startAt` together for confirmed rows; omit both for requests. Capabilities use `|` separators. Export escapes spreadsheet formula prefixes. See the example CSV and schema endpoint.

## Webhooks

Create endpoints through `/integrations/webhooks`; save the secret returned once. Verify `X-DockSlot-Signature` as hex HMAC-SHA256 of `timestamp + '.' + rawBody` using your secret; `X-DockSlot-Timestamp` is Unix seconds. Compare signatures in constant time and apply a timestamp freshness policy. Deduplicate `X-DockSlot-Event-Id`. Endpoint filters match exact event names, or an empty list receives all organization events.

Any 2xx is success. Other statuses, redirects and network failures retry up to 8 attempts with exponential delay, capped at one hour. Failed deliveries are visible and can be manually retried. URLs require HTTPS/public IPs unless a trusted local operator explicitly enables private targets. Signing secrets are encrypted at rest. Generic operational mutation events currently contain a before/after site snapshot in audit and an after snapshot in the outbox; restrict webhook recipients to trusted organization systems.
