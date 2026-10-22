# Backup and restore

Back up PostgreSQL and the webhook encryption key; the web/API/worker are stateless. Use a database client of the same or a newer major version as the server. Keep backups encrypted, access-controlled, and off the database host.

## Compose backup

```sh
docker compose exec -T postgres pg_dump -U dockslot -d dockslot -Fc -f /tmp/dockslot.dump
docker compose cp postgres:/tmp/dockslot.dump ./dockslot.dump
```

Using `pg_dump -f` inside the container avoids binary corruption from shell redirection, including older PowerShell versions. Take backups before migrations and on a documented schedule. Record the application revision, PostgreSQL version, backup timestamp and encryption-key identifier.

## Restore rehearsal (isolated database)

```sh
docker compose cp ./dockslot.dump postgres:/tmp/restore.dump
docker compose exec -T postgres createdb -U dockslot dockslot_restore_check
docker compose exec -T postgres pg_restore -U dockslot -d dockslot_restore_check --no-owner --exit-on-error /tmp/restore.dump
docker compose exec -T postgres psql -U dockslot -d dockslot_restore_check -c 'SELECT count(*) FROM appointments; SELECT count(*) FROM audit_events;'
```

Never restore over an active production database to test a backup. Connect a separately configured application to the restored database, verify login, calendar, audit and proposals, and check overlap integrity. Do not start webhook delivery against real endpoints during rehearsal. A restore to the same database requires an explicit outage and a reviewed procedure.

The repository also includes `scripts/verify-backup.ts`: set `DATABASE_URL` to a development database and `PG_BIN` to the PostgreSQL client executable directory (optional if on PATH). It creates a dump, restores into a uniquely named database, compares entity counts, checks active overlaps, and drops only that newly created verification database. Never use the helper on an untrusted or production connection.
