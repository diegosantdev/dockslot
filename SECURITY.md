# Security policy

The initial 0.1.x implementation has not received an independent security assessment. Only the latest main branch receives fixes while the project is pre-release.

Do not post exploitable vulnerabilities, operational data, driver information or credentials in public issues. Once this repository is published, use the host's **private vulnerability reporting** feature. Repository owners should enable that feature before accepting external deployments. If private reporting is not enabled, contact the repository owner through a private channel listed on their profile; there is no fabricated security mailbox.

Include the affected revision, prerequisites, reproduction steps and expected impact. Remove unrelated data. Maintainers should acknowledge reports, reproduce privately, coordinate a fix, then publish a concise advisory.

The default `AUTH_MODE=local` is an account-free workspace for one computer. Keep it on loopback; programs running locally have full access to its configured organization. Browser origin/Host checks reduce cross-site and DNS rebinding exposure but do not replace authentication for shared deployments.

For a shared deployment: select `AUTH_MODE=session`, use TLS, disable demo seeding, choose unique database credentials, set `COOKIE_SECURE=true`, configure `WEB_ORIGIN`, set a random 32-byte `ENCRYPTION_KEY`, protect backups, and expose the application through a trusted reverse proxy. Internal database and worker endpoints need no public ingress. Do not enable `WEBHOOK_ALLOW_PRIVATE` for untrusted integration administrators.

Passwords use Argon2id. Session/service/portal tokens are stored as SHA-256 hashes. Webhook secrets use AES-256-GCM; protect the encryption key separately from the database. Webhook destinations are validated on every attempt and DNS results are pinned; redirects are not followed. Telemetry is disabled by default. See the deployment and retention documentation for remaining limitations.
