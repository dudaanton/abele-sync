// Test-only process for independent daemon/engine regressions until the unified adapter lands.
// The public server and admin CLI never import this and never expose legacy routes.
import { pathToFileURL } from 'node:url'
import { BlobStore } from '../../dist/blobs/store.js'
import { loadConfig } from '../../dist/config.js'
import { createDb } from '../../dist/db/connect.js'
import { EventHub } from '../../dist/events/hub.js'
const { createAccount } = await import(
  new URL('../../../../.scratch/retained-test/tests/legacy/src/auth/accounts.js', import.meta.url)
)
const { buildRetainedEngineTestApp } = await import(
  new URL('../../../../.scratch/retained-test/tests/helpers/retainedEngineApp.js', import.meta.url)
)
const { runRetainedEngineMigrations } = await import(
  new URL(
    '../../../../.scratch/retained-test/tests/helpers/retainedEngineMigrations.js',
    import.meta.url
  )
)
export { runRetainedEngineMigrations }

async function main() {
  const config = loadConfig(process.env)
  const handle = createDb(config.databaseUrl)
  let app
  try {
    await runRetainedEngineMigrations(handle.db)
    if (process.argv[2] === 'create-account') {
      const args = process.argv.slice(3)
      await createAccount(
        { db: handle.db, pepper: config.tokenPepper, accountTokenTtlMs: 3600000 },
        args[args.indexOf('--email') + 1],
        args[args.indexOf('--password') + 1]
      )
      await handle.close()
      return
    }
    app = await buildRetainedEngineTestApp({
      config,
      db: handle.db,
      dialect: handle.dialect,
      store: new BlobStore(config.blobDir, config.masterKey),
      hub: new EventHub(),
    })
    await app.listen({ port: config.port, host: config.host })
    let stopping = false
    const stop = async () => {
      if (stopping) return
      stopping = true
      await app.close()
      await handle.close()
    }
    process.on('SIGTERM', stop)
    process.on('SIGINT', stop)
  } catch (error) {
    await app?.close().catch(() => {})
    await handle.close().catch(() => {})
    throw error
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
