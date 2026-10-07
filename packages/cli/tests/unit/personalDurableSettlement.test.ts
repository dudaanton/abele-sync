import { expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { resolve, join } from 'node:path'
import {
  SyncClient,
  ExpectedWrites,
  encodeText,
  sha256,
  pull,
  push,
  scan,
  resumeJournal,
  type OwnerSettlement,
  type Journal,
} from '@abele/sync-core'
import { SqliteStateStore } from '../../src/sqliteState.js'
import { NodeFileSystem } from '../../src/nodeFs.js'
import { scopedFixture } from '@abele/sync-server/tests/helpers/scopedFixture.js'
import { commit, create, putBlob, shaOf } from '@abele/sync-server/tests/helpers/ops.js'
import { prepareFolderAdmissions } from '@abele/sync-server/src/scoped/admissions.js'
import { readIntrinsicSponsorProof } from '@abele/sync-server/src/scoped/sponsorProof.js'
import { readSponsoredAssets, addSponsoredAsset } from '@abele/sync-server/src/scoped/assets.js'

for (const boundary of [
  'scan-hint',
  'journal-retirement',
  'content-read',
  'content-restat',
] as const)
  it(`reopens a nonempty submitted merge journal after ${boundary} interruption without losing unsent bytes or duplicating publication`, async () => {
    const scratch = resolve(process.cwd(), 'data')
    mkdirSync(scratch, { recursive: true })
    const dir = mkdtempSync(join(scratch, 'sample-durable-settlement-')),
      vaultDir = join(dir, 'vault')
    mkdirSync(vaultDir)
    const f = await scopedFixture('sqlite'),
      file = join(dir, 'ledger.db'),
      publicationFile = join(dir, 'publication-request.json')
    let raw = SqliteStateStore.open(file)
    try {
      const path = 'Agents/sample-note.md',
        base = 'aaa\nbbb\nccc\n',
        submitted = 'xxx\nbbb\nccc\n',
        remote = 'aaa\nbbb\nyyy\n',
        merged = 'xxx\nbbb\nyyy\n',
        unsent = 'zzz\nbbb\nccc\n'
      await putBlob(f.t.app, f.device.deviceToken, base)
      const first = (await commit(f.t.app, f.device.deviceToken, f.vault, [create(path, base)]))
        .results[0]
      await putBlob(f.t.app, f.device.deviceToken, 'sample-image')
      const image = (
        await commit(f.t.app, f.device.deviceToken, f.vault, [
          create('Attachments/sample-image.png', 'sample-image'),
        ])
      ).results[0]
      await prepareFolderAdmissions(f.deps, f.owner.accountToken, f.vault, f.grant.id)
      const endpoint = await f.t.app.listen({ host: '127.0.0.1', port: 0 })
      const makeClient = () =>
        new SyncClient({ baseUrl: endpoint, token: f.device.deviceToken, fetch }).forVault(f.vault)
      const client = makeClient(),
        fs = new NodeFileSystem(vaultDir),
        expected = new ExpectedWrites(),
        filter = { excluded: () => false }
      await pull(client, fs, raw, { expected, filter, dirty: new Set() })
      await fs.writeAtomic(path, encodeText(submitted), 2)
      const found = await scan(fs, raw, filter),
        sentStat = await fs.stat(path),
        originalEntry = await raw.byFileId(first.file_id)
      expect(found.ops).toEqual([
        expect.objectContaining({ op: 'modify', file_id: first.file_id, sha: shaOf(submitted) }),
      ])
      await putBlob(f.t.app, f.device.deviceToken, remote)
      await commit(f.t.app, f.device.deviceToken, f.vault, [
        {
          op: 'modify',
          file_id: first.file_id,
          base_version_id: first.version_id,
          sha: shaOf(remote),
          size: remote.length,
          mtime: 3,
        },
      ])
      let committed = false,
        contentReads = 0,
        faultObserved = false,
        restatArmed = false
      const actualCommit = client.commitRaw.bind(client)
      vi.spyOn(client, 'commitRaw').mockImplementation(async (...args) => {
        const result = await actualCommit(...args)
        committed = true
        expect(result.body.results[0]).toMatchObject({ status: 'merged', sha: shaOf(merged) })
        if (boundary !== 'content-restat') await fs.writeAtomic(path, encodeText(unsent), 2)
        return result
      })
      if (boundary === 'content-read' || boundary === 'content-restat') {
        const actualRead = fs.read.bind(fs),
          actualStat = fs.stat.bind(fs)
        vi.spyOn(fs, 'read').mockImplementation(async (name) => {
          const bytes = await actualRead(name)
          if (committed && name === path && ++contentReads === 2) {
            if (boundary === 'content-read') {
              faultObserved = true
              throw new Error('sample content read fault')
            }
            await fs.writeAtomic(path, encodeText(unsent), 2)
            restatArmed = true
          }
          return bytes
        })
        vi.spyOn(fs, 'stat').mockImplementation(async (name) => {
          if (name === path && restatArmed) {
            restatArmed = false
            faultObserved = true
            throw new Error('sample content restat fault')
          }
          return actualStat(name)
        })
      }
      let hintAttempted = false
      const actualPut = raw.put.bind(raw),
        actualJournal = raw.setJournal.bind(raw)
      vi.spyOn(raw, 'put').mockImplementation(async (entry) => {
        await actualPut(entry)
        if (
          committed &&
          entry.fileId === first.file_id &&
          entry.versionId === first.version_id &&
          entry.sha === shaOf(submitted)
        ) {
          hintAttempted = true
          if (boundary === 'scan-hint') throw new Error('sample settlement interrupted')
        }
      })
      vi.spyOn(raw, 'setJournal').mockImplementation(async (journal) => {
        if (committed && journal === null) throw new Error('sample settlement interrupted')
        await actualJournal(journal)
      })
      const hook = async (item: OwnerSettlement, bytes: Uint8Array | null, requestId: string) => {
        expect(item.fileId).toBe(first.file_id)
        expect(item.sha).toBe(shaOf(merged))
        expect(bytes).toEqual(encodeText(merged))
        let input
        if (existsSync(publicationFile)) input = JSON.parse(readFileSync(publicationFile, 'utf8'))
        else {
          const proof = await readIntrinsicSponsorProof(
              f.deps,
              f.device.deviceToken,
              f.vault,
              f.grant.id,
              first.file_id
            ),
            view = await readSponsoredAssets(f.deps, f.device.deviceToken, f.vault, f.grant.id)
          input = {
            grantId: f.grant.id,
            expectedRevision: view.revision,
            withdrawalGeneration: view.withdrawalGeneration,
            intentId: `sample-${requestId}`,
            decisionDeviceId: f.device.deviceId,
            target: {
              fileId: image.file_id,
              versionId: image.version_id,
              sha: shaOf('sample-image'),
              path: 'Attachments/sample-image.png',
              eligible: true,
            },
            sponsors: [proof.sponsor],
            reason: 'confirmed-existing',
          }
          writeFileSync(publicationFile, JSON.stringify(input))
        }
        await addSponsoredAsset(f.deps, f.device.deviceToken, f.vault, f.grant.id, input)
      }
      await expect(push(client, fs, raw, found, { expected, onSettled: hook })).rejects.toThrow(
        'sample settlement interrupted'
      )
      expect(hintAttempted).toBe(true)
      if (boundary.startsWith('content-')) expect(faultObserved).toBe(true)
      expect(readFileSync(join(vaultDir, path), 'utf8')).toBe(unsent)
      expect(await fs.stat(path)).toEqual(sentStat)
      const pending = await raw.getJournal()
      expect(pending?.publicationPhase).toBe('submitted')
      expect(pending?.ops).toHaveLength(1)
      expect(pending?.ops[0]).toEqual(found.ops[0])
      expect(await raw.byFileId(first.file_id)).toEqual(originalEntry)
      const versions = await f.t.db
        .selectFrom('versions')
        .select(['id', 'file_id', 'seq', 'blob_sha'])
        .orderBy('seq')
        .execute()
      const receipts = await f.t.db
        .selectFrom('idempotency')
        .selectAll()
        .where('key', '=', pending!.idempotencyKey)
        .execute()
      expect(receipts).toHaveLength(1)
      const head = await f.t.db
        .selectFrom('files')
        .select('head_version_id')
        .where('id', '=', first.file_id)
        .executeTakeFirstOrThrow()
      const beforePublication = await f.t.db
        .selectFrom('scope_extra_entries')
        .select('id')
        .execute()
      expect(beforePublication).toHaveLength(boundary === 'scan-hint' ? 0 : 1)
      vi.restoreAllMocks()
      raw.close()
      raw = SqliteStateStore.open(file)
      const reopened = await raw.getJournal()
      expect(reopened).toEqual(pending)
      const secondClient = makeClient(),
        secondFs = new NodeFileSystem(vaultDir),
        sentBodies: { ops: unknown; key: string }[] = [],
        replayCommit = secondClient.commitRaw.bind(secondClient)
      vi.spyOn(secondClient, 'commitRaw').mockImplementation(async (ops, key) => {
        sentBodies.push({ ops: structuredClone(ops), key })
        const result = await replayCommit(ops, key)
        expect(result.replayed).toBe(true)
        return result
      })
      const recovered = await resumeJournal(secondClient, secondFs, raw, {
        expected: new ExpectedWrites(),
        onSettled: hook,
      })
      expect(recovered?.replayed).toBe(true)
      expect(recovered?.kept).toContain(path)
      expect(sentBodies).toEqual([{ ops: pending!.ops, key: pending!.idempotencyKey }])
      expect(await raw.getJournal()).toBeNull()
      expect(readFileSync(join(vaultDir, path), 'utf8')).toBe(unsent)
      const hint = await raw.byFileId(first.file_id)
      expect(hint?.versionId).toBe(first.version_id)
      raw.close()
      raw = SqliteStateStore.open(file)
      expect(await raw.byFileId(first.file_id)).toEqual(hint)
      expect((await scan(secondFs, raw, filter)).ops).toEqual([
        expect.objectContaining({
          op: 'modify',
          file_id: first.file_id,
          base_version_id: first.version_id,
          sha: shaOf(unsent),
        }),
      ])
      expect(hint?.mtime).not.toBe(sentStat!.mtime)
      await pull(secondClient, secondFs, raw, {
        expected: new ExpectedWrites(),
        filter,
        dirty: new Set(),
      })
      expect(readFileSync(join(vaultDir, path), 'utf8')).toBe(unsent)
      expect(
        await f.t.db
          .selectFrom('versions')
          .select(['id', 'file_id', 'seq', 'blob_sha'])
          .orderBy('seq')
          .execute()
      ).toEqual(versions)
      expect(
        (
          await f.t.db
            .selectFrom('files')
            .select('head_version_id')
            .where('id', '=', first.file_id)
            .executeTakeFirstOrThrow()
        ).head_version_id
      ).toBe(head.head_version_id)
      expect(
        await f.t.db
          .selectFrom('idempotency')
          .selectAll()
          .where('key', '=', pending!.idempotencyKey)
          .execute()
      ).toEqual(receipts)
      expect(await f.t.db.selectFrom('scope_extra_entries').select('id').execute()).toHaveLength(1)
      expect(
        await f.t.db.selectFrom('scope_publication_outcomes').select('intent_id').execute()
      ).toHaveLength(1)
      if (boundary !== 'scan-hint')
        expect(await f.t.db.selectFrom('scope_extra_entries').select('id').execute()).toEqual(
          beforePublication
        )
    } finally {
      vi.restoreAllMocks()
      raw.close()
      await f.close()
      rmSync(dir, { recursive: true, force: true })
    }
  })
