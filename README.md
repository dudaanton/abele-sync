# Abele Sync

Sync server and portable file engine for Abele/Obsidian. The rebuild uses one
user, one space, token principals and one API for root, folder and group access.

**Current rebuild boundary: stages 0–1.** Token provisioning/management works;
the v2 file/feed contract is frozen but the unified file API and engine adapter
are not implemented yet. This is not a complete sync release.

## Development

Node 22 or later, npm workspaces:

```sh
npm ci
npm run build
npm run types
npm test -- --maxWorkers=2
npm run test:sql:disposable
```

Packages:

- `protocol`: wire schemas, paths, errors and portable base64 token helpers.
- `server`: fresh SQLite/PostgreSQL schema, local provisioning, token API, retained
  file/version/blob/history engine.
- `core`: production sync engine, token management client and numbered acceptance
  harness with two real HTTP servers and three independent durable devices.
- `cli`: retained filesystem/state and engine host; its independent regression
  fixtures are not proof of a working rebuilt token sync CLI.

No old data is in use and no conversion/old-client compatibility is provided.
Recreate the unused stand. Legacy access source dependencies of the protected
retained writer are an explicit remaining integration dependency, not a deployed
fallback.

## Reference

- [Deployment and local provisioning](docs/deploy.md)
- [Frozen v2 protocol](docs/protocol-v2.md)
- [Protocol availability](docs/protocol.md)
- [Storage](docs/schema.md)
- [Security boundaries](docs/security.md)
- [Retained external-file CLI state](docs/external-file-cli-state.md)
- [Acceptance manifest](packages/core/tests/acceptance/manifest.json)

Acceptance scenarios not implemented yet are numbered expected failures, never
silently skipped. Mac and physical iPhone evidence remains distinct from server
checks. The project is licensed under [GPL-3.0](LICENSE).
