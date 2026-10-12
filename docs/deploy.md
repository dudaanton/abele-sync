# Deploying the token server

Stage 1 serves token provisioning/management only. The v2 file/feed contract is
frozen but file sync is not operational yet. Do not treat passing retained-engine
regressions as a release gate for the rebuilt sync product.

## Host configuration

Node 22 or later; install with `npm ci` and build with `npm run build`.

Required environment:

- `ABELE_MASTER_KEY`: 64 hex characters (32 random bytes), for encrypted blobs.
- `ABELE_TOKEN_PEPPER`: an independent high-entropy secret for key digests.

Storage/network environment:

- `ABELE_DATABASE_URL`: SQLite (`sqlite://data/abele.db`) or PostgreSQL URL.
- `ABELE_BLOB_DIR`: defaults to `data/blobs`.
- `ABELE_PORT`: defaults to 8787.
- `ABELE_HOST`: defaults to `0.0.0.0`; bind loopback behind a reverse proxy.
- `ABELE_TRUST_PROXY`: enable only for the actual trusted proxy addresses.
- `ABELE_CONFIGURATION_DIRS`: optional bounded JSON array of configuration roots.
- `ABELE_PUBLIC_URL`: retained fixture/configuration address hint; new token issuance uses the operator's explicit `--address`, not this hint.

The [compose example](../docker-compose.example.yml) supplies a disposable
PostgreSQL service with a digest-pinned image. Protect database credentials and
never expose its port publicly. For remote clients use HTTPS through a trusted
proxy; keep the server's credential-bearing traffic off plaintext networks.

## Fresh installation

Nobody has used sync; there is no data cutover or account conversion. Recreate
the unused test stand rather than applying an upgrade to its old database.
Startup refuses old account/device/grant schemas without modifying their data.

```sh
node packages/server/dist/admin-cli/index.js user create \
  --label 'Owner' --address 'https://sync.example'
node packages/server/dist/index.js
```

The first command prints the root connection token (also the QR payload). Paste
it using the rebuilt host adapter; issue independent device/share tokens through
`POST /v2/tokens`. Do not use old password/login/enrolment CLI commands or old
clients: the public server exposes no `/v1` compatibility endpoints.

`GET /healthz` is a cheap liveness check. `GET /capabilities` reports protocol 2
and token authentication; `/v2/connection` validates an actual key.

## Storage operations

`abele-sync-admin gc` runs retained storage cleanup for token spaces. `backup
--to <new-directory>` creates a SQLite database/blob snapshot, excludes partial
uploads, and verifies every referenced blob. PostgreSQL backup requires an
externally coordinated consistent database/blob snapshot with writers and
collectors stopped; the local backup command refuses to claim it can do that.
Keep the encryption key separately available for restoration.

## Verification

```sh
npm run types
npm test -- --maxWorkers=2
npm run test:sql:disposable
```

Numbered acceptance tests explicitly report unimplemented cases as expected
failures. Passing that command does not mean all 124 scenarios are implemented.
Mac and physical iPhone evidence is recorded separately and cannot be supplied by
core simulations. The [v2 contract](protocol-v2.md) and
[storage schema](schema.md) describe the implemented boundary.
