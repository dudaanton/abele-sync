# abele-sync

Self-hosted sync server for the [Abele Obsidian plugin](https://github.com/dudaanton/abele-obsidian-plugin)
**2.0+**, and a command-line daemon for syncing vault directories without Obsidian.
This repository contains the server, CLI, shared sync engine and wire protocol.
It is not a hosted service.

## What it does

- Syncs notes, attachments and selected Obsidian settings across devices.
- Keeps version history and trash with configurable retention and quotas.
- Reconciles concurrent note edits on the server; retains losing versions and
  makes conflict copies when a safe merge is not possible.
- Encrypts stored blobs with the server's master key and authenticates accounts
  and enrolled devices. This is **server-side encryption, not end-to-end
  encryption**: the server operator can read vault content.
- Offers selective sync, a mass-deletion guard and explicit approval of incoming
  plugin code in the CLI.
- Supports PostgreSQL and SQLite, plus optional folder/group scoped sharing and
  a restricted `Agents/` daemon.

## Status

The personal sync server and daemon are implemented and tested. Scoped sharing
is implemented but **off by default**; enable it only after reviewing the
[security model](docs/security.md#scoped-visibility), registered
configuration roots and client compatibility. Agent mode is currently limited
to an editor folder grant for `Agents/`; it is not a general-purpose publisher.
Keep client/server builds compatible and back up before upgrades. There is no
uptime guarantee or managed hosting offered by this repository.

## Quick start: Docker Compose

Requires Docker with Compose v2. The example builds locally, runs PostgreSQL 16
and the server as a non-root user, and keeps data in named volumes. Published
release images are configured by the tag workflow at
`ghcr.io/dudaanton/abele-sync`; use a specific release version when available.

```sh
git clone https://github.com/dudaanton/abele-sync.git
cd abele-sync
cp .env.example .env
chmod 600 .env
# Generate THREE independent secrets, and fill MASTER_KEY, TOKEN_PEPPER and
# PG_PASSWORD in .env with the output of separate invocations:
openssl rand -hex 32
cp docker-compose.example.yml compose.yml
docker compose up -d --build --wait
curl --fail http://127.0.0.1:8787/healthz
```

Keep the master key securely: losing it loses the stored content. Keep `.env`
out of version control and backups accessible only to trusted operators.

Create an account (there is no public signup) and vault. The admin CLI currently
requires the password as an argument: the following avoids shell history, but
privileged process inspection can still see it while the command runs.

```sh
read -rs -p 'Account password: ' PASSWORD; echo
docker compose exec -e ACCOUNT_PASSWORD="$PASSWORD" server sh -c \
  'node packages/server/dist/admin-cli/index.js create-account --email you@example.com --password "$ACCOUNT_PASSWORD"'
unset PASSWORD
docker compose exec server node packages/server/dist/admin-cli/index.js \
  create-vault --owner-email you@example.com --name 'My Vault'
```

For a local trial connect the plugin to `http://localhost:8787`. For another
machine, put the server behind HTTPS first; clients refuse non-loopback HTTP.
The default published port is loopback-only, PostgreSQL is not published, and
`GET /healthz` is a liveness probe, not a database integrity check.

See **[docs/deploy.md](docs/deploy.md)** for all environment variables, Caddy and
nginx TLS examples, backups/restore, SQLite, upgrades and daemon deployment.
`docker-compose.example.yml` is the sole committed Compose example; copy it to
`compose.yml` for your local configuration. The optional `tls` profile uses the
root `Caddyfile`.

### Scoped sharing switch

```dotenv
ABELE_SCOPED_SHARING=off
```

Only literal `on` enables the scoped sync, management and publication routes;
unset or `off` keeps them closed. This does not narrow an ordinary personal
device token: it still has access to its vault. Agent deployments need their
own scoped machine key, never an owner password or personal device token.

## CLI

Build from source with Node 22+:

```sh
npm ci
npm run build
# This is the abele-sync command; no npm package publication is assumed.
node packages/cli/dist/index.js --help
node packages/cli/dist/index.js init --server https://sync.example.com \
  --dir /path/to/vault --email you@example.com --vault 'My Vault'
node packages/cli/dist/index.js run --dir /path/to/vault
node packages/cli/dist/index.js status --dir /path/to/vault
```

`init` asks for the account password at a terminal. Run one daemon per vault,
and do not share its `.abele-sync` state folder through another sync tool.
[The deployment guide](docs/deploy.md#daemon-deployment) covers Docker, systemd
and scoped agent setup. Use `--help` on individual commands for history,
restore, held deletions and plugin-code approval.

## Development

```sh
npm ci
npm run types
npm run format:check  # repository lint/format gate (Prettier)
npm test             # SQLite/unit/scenario/CLI tiers
npm run test:sql:disposable # required PostgreSQL tier in a temporary container
```

`npm test` skips PostgreSQL-specific cases unless `ABELE_TEST_PG_URL` is set.
`npm run test:sql` instead requires that URL and fails if PostgreSQL is absent.
Use a disposable database: the test role must be allowed to create and drop
databases/schemas. CI runs both tiers. Current references cover the
[protocol](docs/protocol.md), [storage and upgrades](docs/schema.md) and
[security model](docs/security.md).

## License

[GNU GPL version 3](LICENSE) (`GPL-3.0-only`), the same license as the plugin.
