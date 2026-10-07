# Deployment

This guide describes the code in this repository, not a hosted service. Run one
server process against a database/blob directory; multi-replica operation is not
claimed (rate limiters and event delivery are process-local). Use compatible
Abele plugin 2.0+ and CLI builds, HTTPS for remote clients, and tested backups.
The server can decrypt all content; storage encryption is not end-to-end.

## Docker and PostgreSQL

From the repository root:

```sh
cp docker-compose.example.yml compose.yml
cp .env.example .env
chmod 600 .env
# Fill three independent random secrets: MASTER_KEY, TOKEN_PEPPER, PG_PASSWORD.
# Use a separate `openssl rand -hex 32` invocation for each.
docker compose up -d --build --wait
curl --fail http://127.0.0.1:8787/healthz
```

`docker-compose.example.yml` is the only committed Compose file; the local
`compose.yml` copy holds your deployment configuration. PostgreSQL 16 uses
`postgres-data`; `/data` in the server uses `server-data` for encrypted blobs.
Both are named volumes; there is no host-directory ownership step. Neither
volume is removed by `docker compose down`; **`down -v` destroys them**.
PostgreSQL is internal-only; the server port is loopback-only by default.
Compose waits for PostgreSQL's TCP health check; the server migrates on startup.

The server image is built with `packages/server/Dockerfile` from the repository
root. Node 22 LTS Debian slim is pinned by a multi-platform digest. The build
stage alone has compiler tools/dev dependencies; runtime is uid/gid 1000 and
contains only production npm dependencies and compiled workspace output.
A `daemon` target provides the CLI entrypoint. The default `server` image also
contains the CLI so the released image can run either without a separate pull.

After a release is published, set `ABELE_IMAGE=ghcr.io/dudaanton/abele-sync:1.2.3`
in `.env` (replace with an actual version), then:

```sh
docker compose pull server
docker compose up -d --no-build --wait
```

The tag workflow builds `linux/amd64` and `linux/arm64`; tags are the semver
without `v`, its major.minor alias, and `latest` for stable releases. Prefer an
immutable digest or exact version over moving aliases. Sources corresponding to
a released image are at the matching `v...` tag in this repository; the image
carries an OCI source/revision label and the license text. If a GHCR package is
initially private, its owner must set package visibility to public.

For an external PostgreSQL instance, remove the example's `postgres` service and
`depends_on`, replace the server `ABELE_DATABASE_URL` override with your URL, and
provide TLS/network controls appropriate to that database. The runtime accepts
`postgres://` and `postgresql://`. It needs DDL permission for migrations and
read/write access to all application tables. Do not expose database credentials
or the database port to clients. URL-encode reserved password characters; the
example recommends a hex password so Compose's assembled URL needs no escaping.
Changing `POSTGRES_PASSWORD` after volume initialization does **not** change an
existing role password: change the database role and server URL together.

### Accounts and administration

There is no public signup. The admin CLI opens the database directly, reads the
same configuration as the server, and runs migrations before its command. Do
not run it from a newer build against a live older server.

```sh
read -rs -p 'Account password: ' PASSWORD; echo
docker compose exec -e ACCOUNT_PASSWORD="$PASSWORD" server sh -c \
  'node packages/server/dist/admin-cli/index.js create-account --email you@example.com --password "$ACCOUNT_PASSWORD"'
unset PASSWORD
docker compose exec server node packages/server/dist/admin-cli/index.js \
  create-vault --owner-email you@example.com --name 'My Vault'
docker compose exec server node packages/server/dist/admin-cli/index.js list-vaults
```

The shell example avoids a saved literal password; the admin CLI's required
`--password` still exposes it to privileged process inspection. Protect the host.
Other admin commands: `reset-password --email ... --password ...` (drops old
account tokens), `gc` (retention, stale uploads and unreferenced blobs), and
`backup --to DIR` (verified SQLite backup only). There is no admin restore command.

## Configuration reference

The complete server environment surface is derived from
[`packages/server/src/config.ts`](../packages/server/src/config.ts). It is read
once, so restart after changes. Defaults below are **code defaults**, not the
Compose overrides.

| Variable                   | Default                  | Meaning                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ABELE_MASTER_KEY`         | Required, no default     | Exactly 64 hexadecimal characters (32 bytes), encrypts blobs and pending upload parts. Losing/changing it makes existing bytes unreadable; preserve it with every backup.                                                                                                                                                                                     |
| `ABELE_TOKEN_PEPPER`       | Required, no default     | Nonempty secret mixed into token hashes. Generate high entropy independently. Changing it invalidates existing account/device/machine credentials; plan reenrolment.                                                                                                                                                                                          |
| `ABELE_DATABASE_URL`       | `sqlite://data/abele.db` | SQLite path after `sqlite://` (relative to cwd, or absolute with a third slash), or PostgreSQL URL. `sqlite::memory:` is for tests, not durable hosting.                                                                                                                                                                                                      |
| `ABELE_BLOB_DIR`           | `data/blobs`             | Encrypted content and pending uploads directory, relative to cwd unless absolute. Must be writable by the runtime user.                                                                                                                                                                                                                                       |
| `ABELE_PUBLIC_URL`         | `http://localhost:8787`  | Configured external URL. Does not enable TLS or change the listener; set to your HTTPS URL.                                                                                                                                                                                                                                                                   |
| `ABELE_PORT`               | `8787`                   | Plain decimal TCP port, 1–65535; unset/empty uses default.                                                                                                                                                                                                                                                                                                    |
| `ABELE_HOST`               | `0.0.0.0`                | Listen interface. Use `0.0.0.0` inside Docker; use loopback for a host-side server behind a proxy.                                                                                                                                                                                                                                                            |
| `ABELE_TRUST_PROXY`        | `false`                  | Unset/empty/`false` ignores forwarded addresses; `true` trusts all hops; otherwise comma-separated proxy IPs/CIDRs. Trust only operator-controlled proxies; direct clients must not spoof the rate-limit address.                                                                                                                                             |
| `ABELE_SCOPED_SHARING`     | `off`                    | Only `on`/`off` accepted. All-or-nothing scoped sync, folder/group management and publication activation; unset is off.                                                                                                                                                                                                                                       |
| `ABELE_CONFIGURATION_DIRS` | `[]` additional roots    | JSON array of up to 16 additional literal canonical root directory names. `.obsidian` is always registered, case-normalized, and excluded from scoped sharing. No paths, separators, whitespace padding or wildcards. Register actual alternate configuration roots before enabling sharing. Changes require review/view invalidation, not just a hot reload. |

Upload sizes, account-token TTL (one hour), idempotency TTL (24 hours), retention
sweep interval (six hours) and WebSocket hello timeout (five seconds) are code
constants, **not** extra environment settings. Per-vault settings control quotas,
retention and selective behavior; changing retention/quota requires password
confirmation. See the protocol and client command help for the API surface.

Compose-only variables in the example are `ABELE_PG_USER` (abele),
`ABELE_PG_DATABASE` (abele), `ABELE_PG_PASSWORD` (required), `ABELE_BIND`
(127.0.0.1), `ABELE_IMAGE` (abele-sync:local) and `ABELE_DOMAIN` (localhost if
unset). They are not read by server `config.ts`. Tests use `ABELE_TEST_PG_URL`,
never your production database.

Scoped sharing remains closed unless explicitly enabled. Review the
[security model](security.md#scoped-visibility) before `on`: compatible
clients, prepared grants/views, registered configuration roots and recovery are
operator responsibilities. Turning sharing off is not a substitute for revoking
keys. Ordinary device tokens still authorize a whole personal vault.

## SQLite alternative / source deployment

SQLite is supported for a single server. Remove the `postgres` service and the
server `depends_on` and `environment.ABELE_DATABASE_URL` override from Compose.
Set `ABELE_DATABASE_URL=sqlite:///data/abele.db` in `.env`; retain `server-data`.
The image initializes `/data` with the runtime user's ownership. Do not put the
SQLite file on an unreliable/network filesystem or run multiple servers over it.
There is no built-in PostgreSQL↔SQLite data conversion.

Without Docker, use Node 22+, `npm ci`, `npm run build`, and set all required
environment values in your process manager (a `.env` file is **not automatically
loaded** by the server). Then `npm start -w packages/server`. Native
`better-sqlite3` may need Python/make/a C++ compiler if no prebuild is available.
Protect the service account's data directory and secrets; bind `127.0.0.1` when
using a reverse proxy on the same host.

## TLS reverse proxy

Remote CLI/plugin connections require HTTPS. Support WebSocket upgrades and
long idle connections for the event stream, stream uploads, and allow at least
8 MiB plus request overhead. Keep the upstream inaccessible from public peers;
never publish cleartext HTTP on all interfaces beside TLS.

### Caddy (Compose profile)

The root `Caddyfile` is:

```caddyfile
{$ABELE_DOMAIN} {
    reverse_proxy server:{$ABELE_PORT}
}
```

Set `ABELE_DOMAIN=sync.example.com` and
`ABELE_PUBLIC_URL=https://sync.example.com`, point DNS to your server, and allow
inbound TCP 80/443. Caddy manages certificates and supports WebSockets itself.

```sh
docker compose --profile tls up -d --build --wait
```

Before trusting forwarded addresses, give Caddy a known Compose network address
or a dedicated network with an explicit subnet and set `ABELE_TRUST_PROXY` to
that address/CIDR. Do not blindly trust every Docker network or public peer.
If you use `ABELE_TRUST_PROXY=true`, remove the server's `ports` section and
isolate its network so **only your proxy** can connect; use Compose exec to probe
health instead. Caddy persists certificates in `caddy-data`/`caddy-config`.
The default false is secure but counts proxied users under a shared rate budget.

### nginx (on the host)

With the Compose loopback port, install your certificates and configure nginx
in its `http` context. Replace the example domain/certificate paths:

```nginx
map $http_upgrade $abele_connection {
    default upgrade;
    '' close;
}
server {
    listen 80;
    server_name sync.example.com;
    return 301 https://$host$request_uri;
}
server {
    listen 443 ssl;
    server_name sync.example.com;
    ssl_certificate /etc/letsencrypt/live/sync.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/sync.example.com/privkey.pem;
    client_max_body_size 64m;
    location / {
        proxy_pass http://127.0.0.1:8787;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $abele_connection;
        proxy_set_header X-Forwarded-For $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_request_buffering off;
        proxy_read_timeout 1h;
        proxy_send_timeout 1h;
    }
}
```

Test with `nginx -t` before reload. On a source deployment trust only loopback;
with Docker's published port the observed peer may be its bridge gateway. Inspect
that address and trust only the controlled gateway, with loopback publication
and host access controls intact. nginx overwrites `X-Forwarded-For` rather than
accepting a client-provided address.

## Health and logs

`GET /healthz` needs no credentials and returns `{"ok":true}`. It checks HTTP
liveness only, not SQL connectivity, content integrity or sync convergence.
The image health check uses the configured port. Check database health and an
authenticated sync separately for operational readiness.

```sh
docker compose ps
docker compose logs --tail 100 server
```

Use host/container log rotation and disk monitoring. Content, tokens and backup
archives are sensitive even though blob files are encrypted. Avoid printing
connection URLs/secrets in diagnostic output.

## Backups and restore

Back up **database + blob directory + original master key + token pepper** as
one recovery set. Store it off-host with encryption/access controls; test restore
on an isolated deployment. A database alone does not contain note bytes; blobs
alone do not contain authoritative history. Never rotate/delete keys casually.

For a straightforward consistent backup, stop every server/GC/admin writer for
the whole operation. Do not let retention remove bytes while copying. These
examples use the default Compose PostgreSQL user/database; adjust both if changed.

### PostgreSQL

```sh
mkdir -m 700 backups
# Pick a NEW directory each time.
BACKUP=backups/$(date -u +%Y%m%dT%H%M%SZ)
mkdir -m 700 "$BACKUP"
docker compose stop server
# PostgreSQL remains running, but no application writer or GC may run.
docker compose exec -T postgres pg_dump -U abele -d abele -Fc > "$BACKUP/database.dump"
docker compose run --rm --no-deps -T --entrypoint tar server \
  -C /data -czf - blobs > "$BACKUP/blobs.tar.gz"
cp .env "$BACKUP/server.env"
chmod 600 "$BACKUP/"*
docker compose up -d --no-build --wait server
```

Check each command's success before restarting; automate with `set -e` and an
appropriate recovery trap. Include external secrets if `.env` does not hold them.
The admin `backup` command explicitly refuses PostgreSQL: it cannot coordinate
`pg_dump` with blob/GC state itself.

Restore to a **fresh isolated Compose project/empty volumes**, with the original
secrets and compatible image. Disable automatic server startup until restored:

```sh
# In a separate checkout/project, install the saved .env securely first.
docker compose up -d --wait postgres
# The server must remain stopped; this drops/replaces application tables.
docker compose exec -T postgres pg_restore -U abele -d abele \
  --clean --if-exists --no-owner --exit-on-error < "$BACKUP/database.dump"
docker compose run --rm --no-deps -T --entrypoint tar server \
  -C /data -xzf - < "$BACKUP/blobs.tar.gz"
docker compose up -d --no-build --wait server
```

Do not extract over existing live blobs/SQL tables and call that a restore.
Check accounts, vaults, authenticated downloads/history and a disposable client
sync before pointing real clients at a restored server. Old database snapshots
can disagree with clients' cursors; review reconnect/recovery, not just health.

### SQLite

With the server and other writers stopped, run the old/current image's verified
backup command, then export its two outputs:

```sh
docker compose run --rm --no-deps server node \
  packages/server/dist/admin-cli/index.js backup --to /data/backup-unique
# Command must report "backup verified"; an existing output is refused.
docker compose run --rm --no-deps -T --entrypoint tar server \
  -C /data/backup-unique -czf - abele.db blobs > backups/sqlite-backup.tar.gz
```

The CLI uses SQLite `VACUUM INTO`, copies encrypted blobs, and authenticates and
hashes every snapshot version. It excludes unfinished upload parts; clients may
need to resend pending uploads after recovery. Preserve the original secrets
separately. Do not copy a live `.db` alone and omit its WAL. An offline full
volume snapshot including `.db`, any WAL/SHM, and `blobs/uploads` is another
option when all writers are stopped.

Restore the archive into `/data` of a fresh SQLite project/volume using a one-off
`tar` container as above, original keys and `sqlite:///data/abele.db`, then start
the server. Never overwrite a running database; keep the old recovery set intact.
For bind mounts, restore uid/gid 1000 ownership or choose a service uid with
access. Do not use root as the long-running server to hide permission problems.

## Upgrades and migrations

1. Read migration/recovery notes; take and test a database/blob/key backup.
2. Stop old server, all GC/admin processes and daemons. Do not roll a mixed old/
   new writer fleet through a migration. Pin the previous image for rollback.
3. Use the read-only [upgrade preflight](schema.md#upgrade-procedure) against an
   existing database before applying migrations. Keep operational attestations
   and backups private. A daemon transition also needs stopped old writers and
   dedicated local state; do not reuse a personal root as an agent root.
4. Pull/build the chosen version and start one server. Migrations run before
   listening; startup failure is not permission to bypass preflight guards.
5. Inspect logs, health, authenticated sync and history, then restart compatible
   daemons/clients. Re-review scoped grants and configuration registrations.

There is no supported automatic down-migration. To roll back an incompatible
schema, stop the new writers and restore the **matching old database, blobs and
keys**, then start the old image. A failed startup and `healthz` alone do not
prove that an old binary can read a changed schema. Migration 007 retains version
classes independently of current filenames; old GC writers must not run after
that upgrade. The migration cannot restore history already deleted by old GC.

## Daemon deployment

The CLI command is `abele-sync`; in a source checkout invoke it as
`node packages/cli/dist/index.js`. Node does not auto-load `.env` here either.
Personal `init` takes a terminal password or `ABELE_PASSWORD`; prefer those over
`--password` (visible in `ps`). Restart after editing selective configuration or
`.abele-sync-ignore`; they are read at startup.

```sh
node packages/cli/dist/index.js init --server https://sync.example.com \
  --dir /path/to/vault --email you@example.com --vault 'My Vault'
node packages/cli/dist/index.js run --dir /path/to/vault --interval 60
# Or a scheduled one-shot:
node packages/cli/dist/index.js run --dir /path/to/vault --once
```

Keep one process per vault. `.abele-sync` holds credentials (config mode 600), a
SQLite ledger, lock and logs; never share that folder between machines or through
another sync service. Back up the actual vault files too. A stale
`lock.mutation` guard after a crash must only be manually removed once **all**
processes sharing that root are stopped. Never remove it just because a timer
expired. Keep vault roots local and do not follow symlinked subfolders.

### Docker daemon

Use the released server image with an overridden entrypoint, or build
`docker build --target daemon -f packages/server/Dockerfile -t abele-sync-daemon .`.
The released image command is:

```sh
IMAGE=ghcr.io/dudaanton/abele-sync:1.2.3 # choose an existing version
# Vault directory must be writable by uid 1000 (or use --user with its owner uid).
docker run --rm -it --mount type=bind,src=/absolute/vault,dst=/vault \
  --entrypoint node "$IMAGE" /app/packages/cli/dist/index.js \
  init --server https://sync.example.com --dir /vault --email you@example.com
```

A daemon service can be added to a separate Compose file:

```yaml
services:
  daemon:
    image: ghcr.io/dudaanton/abele-sync:1.2.3 # choose an existing version
    entrypoint: ['node', '/app/packages/cli/dist/index.js']
    command: ['run', '--dir', '/vault', '--interval', '60']
    environment:
      ABELE_REVOKED_EXIT_ZERO: '1'
    volumes:
      - /absolute/vault:/vault
    restart: on-failure
    healthcheck:
      disable: true
    stop_grace_period: 60s
```

No HTTP health check applies; inspect logs and `status --dir /vault` using a
one-off CLI reader. With the server image, override/disable its inherited HTTP
health check (`healthcheck: { disable: true }` in Compose). Without that override,
the daemon would be marked unhealthy despite syncing correctly.

CLI exit codes: 0 done, 1 failure, 2 usage, 3 lock conflict/loss, **4 revoked or
unauthorized credentials**. Saved credential-bound terminal status prevents
restart from syncing on that credential. `ABELE_REVOKED_EXIT_ZERO=1` is an
explicit Docker adapter mapping only 4 to 0 so `on-failure` restarts crashes but
not revocation; ordinary CLI use retains exit 4. Do not use `unless-stopped` for
revoked daemons. `on-failure` does not automatically start on Docker restart.
Personal recovery uses a fresh `init --force` after stopping the old daemon.

### systemd

Install the build under a service-readable path and provision the vault as its
user. This example is a foreground process, not an internal daemonizer:

```ini
[Unit]
Description=Abele vault sync
Wants=network-online.target
After=network-online.target
[Service]
Type=simple
User=abele
WorkingDirectory=/opt/abele-sync
ExecStart=/usr/bin/node /opt/abele-sync/packages/cli/dist/index.js run --dir /srv/vault --interval 60
Restart=on-failure
RestartPreventExitStatus=4
TimeoutStopSec=60
UMask=0077
[Install]
WantedBy=multi-user.target
```

Enable after interactive enrolment as that user. SIGTERM/SIGINT waits for the
in-flight sync, closes state and releases the lock. Do not set the Docker
exit-zero adapter here; systemd handles exit 4 explicitly.

### Scoped agent mode

Agent mode is restricted to an **editor folder grant for `Agents/`** and a fresh
dedicated vault root. Enable scoped sharing on the server only after reviewing
activation requirements. An owner must create/prepare the grant and issue a
scoped editor machine key. Never reuse a personal root/token or owner password.

```sh
export ABELE_AGENT_VAULT_ID='<vault-id>'
export ABELE_AGENT_GRANT_ID='<grant-id>'
export ABELE_AGENT_PRINCIPAL_ID='<machine-key-id>'
read -rs ABELE_AGENT_TOKEN; echo
export ABELE_AGENT_TOKEN
node packages/cli/dist/index.js agent setup --server https://sync.example.com \
  --dir /path/to/fresh-agent-root --vault "$ABELE_AGENT_VAULT_ID" \
  --grant "$ABELE_AGENT_GRANT_ID" --principal "$ABELE_AGENT_PRINCIPAL_ID"
unset ABELE_AGENT_TOKEN
node packages/cli/dist/index.js agent run --dir /path/to/fresh-agent-root --interval 60
node packages/cli/dist/index.js agent status --dir /path/to/fresh-agent-root
```

The root is the **vault root**, not its `Agents` child. The token is needed only
for setup; the private local config/ledger persists. Agent scripts default to
refusal, not arbitrary remote execution. It polls (default 30 seconds, minimum
5); `--once` runs one cycle. Use `agent run` in the Docker/systemd commands above
instead of `run`, with the same stop/revocation policy. Agent status reads a local
committed snapshot beside a running daemon without locking or contacting the
server. On revocation, local files, ledger and pending requests remain. Recovery
requires a new owner-issued key and reviewed fresh setup, not an automatic lease
renewal or personal fallback.
