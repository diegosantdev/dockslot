# Deployment

## Local demonstration

Local mode is the default (`AUTH_MODE=local`). The browser opens the workspace without credentials, and the API uses the `local_operator` audit actor. A fresh installation uses `org_local` by default. Set `LOCAL_ORGANIZATION_ID` explicitly to use another existing organization. The browser cannot switch organizations by sending a header in local mode. No user accounts are created by the local seed.

Without Docker, run `npm ci` then `npm run local`. The embedded database, web and API bind to loopback. `.local/` holds persistent data and the webhook encryption key. To start empty, set `DEMO_MODE=false` before launch. Stop with Ctrl+C and reopen with the same command. The `demo:local` command is an alias.

Local mode trusts programs running on your computer. The API rejects foreign browser origins, cross-site browser requests and unexpected Host headers. Explicit bearer credentials still undergo their normal scope checks. Do not publish a local-mode instance on the internet. For a shared installation, select session mode below.

`docker compose up --build -d` starts PostgreSQL, a one-shot migration/demo service, API, worker and web. The database is persistent in a named volume. Demo seed is explicit through `DEMO_MODE=true` (the local Compose default) and idempotent. Do not remove volumes unless intentionally deleting all data. `docker compose down` stops services without deleting the volume.

The web server proxies `/v1` to the API. Ports bind to `127.0.0.1`; PostgreSQL has no published port. Logs use request IDs and redact cookies/authorization and portal token paths.

## Operational deployment

1. Set `AUTH_MODE=session` and `DEMO_MODE=false` **before first startup**. An existing demo is not erased by changing these flags. The login screen's **Initialize your workspace** action creates the first administrator. If converting an existing local workspace, bootstrap creates a separate organization; transfer its membership/data deliberately before switching rather than assuming it will inherit local data.
2. Set a strong unique `POSTGRES_PASSWORD`. URLs must encode reserved characters in credentials.
3. Set `ENCRYPTION_KEY` to 64 hex characters generated with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`. Back up this key separately; existing secrets cannot be decrypted after losing it. Key rotation requires decrypt/re-encrypt migration.
4. Set `WEB_ORIGIN=https://your-host.example` and `COOKIE_SECURE=true`.
5. Put web/API behind a TLS reverse proxy. Disable buffering for SSE, allow idle connections, and proxy the original Origin header. Set body limits appropriate for 1 MB CSV imports. Do not publicly expose the database.
6. Initialize the first admin locally before public exposure. Create site-scoped users with the narrowest appropriate role, replace temporary passwords, and grant only needed token scopes.
7. Run backup/restore drills, load tests, and review operational policies before real use.

No application usage telemetry is sent. Next telemetry is disabled in Docker and the local demo helper; set `NEXT_TELEMETRY_DISABLED=1` when developing independently. Fonts use local system fallbacks. No external font/CDN access is required.

## Health and operations

`/v1/health/live` checks the process; `/v1/health/ready` checks database/schema access. Inspect `docker compose logs api worker init`. The worker can restart without losing committed outbox events. Delivery failures remain visible and are retried with persistent state. Do not run simultaneous schema versions during migration; back up and coordinate upgrades.

Configuration reference: `.env.example`. The provided service topology is a single-host baseline. Rate limiting is per API process; use an edge/shared rate limiter before scaling horizontally. SSE currently polls PostgreSQL rather than using LISTEN/NOTIFY. Structured logging is present; a Prometheus/OpenTelemetry exporter is future work.

## Privacy and retention

Store only necessary carrier/vehicle references and notes. Avoid driver identity documents in free text. Data and events remain inside the installation except explicitly configured webhooks. No automatic retention deletion runs. Audit is append-only in the application/database trigger. Choose an organization retention period before production; implement reviewed anonymization/archival migrations and protected backups according to local requirements. Exports and backups may contain sensitive operational data. This project does not claim jurisdiction-specific compliance.
