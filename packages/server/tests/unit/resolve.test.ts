import { describe, it, expect } from 'vitest'
import { VaultSettingsSchema } from '@abele/sync-protocol'
import { decide, type HeadState } from '../../src/oplog/resolve.js'

const S1 = '1'.repeat(64)
const S2 = '2'.repeat(64)
const settings = (conflict: 'merge' | 'conflict-file') => VaultSettingsSchema.parse({ conflict })
const head = (o: Partial<HeadState>): HeadState => ({
  fileId: 'f',
  path: 'a.md',
  kind: 'note',
  deleted: false,
  versionId: 'v2',
  sha: S2,
  size: 2,
  mtime: 5,
  no: 2,
  baseIsKnown: 'yes',
  baseSha: S1,
  basePath: 'a.md',
  ...o,
})

describe('decide', () => {
  it('1 create on a free path applies', () => {
    expect(
      decide(
        { op: 'create', path: 'a.md', sha: S1, size: 1, mtime: 1 },
        null,
        settings('merge'),
        false
      )
    ).toMatchObject({ kind: 'apply', op: 'create', path: 'a.md', sha: S1 })
  })
  it('2 create on a taken note path merges from an empty base', () => {
    expect(
      decide(
        { op: 'create', path: 'a.md', sha: S1, size: 1, mtime: 5 },
        head({}),
        settings('merge'),
        true
      )
    ).toMatchObject({ kind: 'merge', status: 'merged' })
  })
  it('3 create on a taken note path makes a conflict file in conflict-file mode', () => {
    expect(
      decide(
        { op: 'create', path: 'a.md', sha: S1, size: 1, mtime: 5 },
        head({}),
        settings('conflict-file'),
        true
      )
    ).toMatchObject({ kind: 'conflict-file' })
  })
  it('4 create on a taken attachment path: newer mtime wins', () => {
    expect(
      decide(
        { op: 'create', path: 'a.png', sha: S1, size: 1, mtime: 9 },
        head({ path: 'a.png', kind: 'attachment', mtime: 5 }),
        settings('merge'),
        true
      )
    ).toMatchObject({ kind: 'apply', op: 'modify', path: 'a.png' })
    expect(
      decide(
        { op: 'create', path: 'a.png', sha: S1, size: 1, mtime: 1 },
        head({ path: 'a.png', kind: 'attachment', mtime: 5 }),
        settings('merge'),
        true
      )
    ).toMatchObject({ kind: 'head-newer', status: 'merged' })
  })
  it('5 a deleted file is never handed to decide as the head of a create, which sees row 1', () => {
    // commit.ts loads only the live file at the path; api.commit.test.ts proves the deleted one stays.
    expect(
      decide(
        { op: 'create', path: 'a.md', sha: S1, size: 1, mtime: 1 },
        null,
        settings('merge'),
        false
      )
    ).toMatchObject({ kind: 'apply', op: 'create', path: 'a.md', sha: S1 })
  })
  it('2b create carrying the bytes the head already has is a noop', () => {
    expect(
      decide(
        { op: 'create', path: 'a.md', sha: S2, size: 2, mtime: 9 },
        head({}),
        settings('merge'),
        true
      )
    ).toMatchObject({ kind: 'noop', status: 'applied' })
    expect(
      decide(
        { op: 'create', path: 'a.png', sha: S2, size: 2, mtime: 9 },
        head({ path: 'a.png', kind: 'attachment' }),
        settings('conflict-file'),
        true
      )
    ).toMatchObject({ kind: 'noop' })
  })
  it('6 modify with the head as base applies', () => {
    expect(
      decide(
        { op: 'modify', file_id: 'f', base_version_id: 'v2', sha: S1, size: 1, mtime: 9 },
        head({}),
        settings('merge'),
        false
      )
    ).toMatchObject({ kind: 'apply', op: 'modify' })
  })
  it('7 modify over a deleted head undeletes with the new content', () => {
    expect(
      decide(
        { op: 'modify', file_id: 'f', base_version_id: 'v1', sha: S1, size: 1, mtime: 9 },
        head({ deleted: true }),
        settings('merge'),
        false
      )
    ).toMatchObject({ kind: 'apply', op: 'modify', path: 'a.md' })
  })
  it('8 modify over a head that only moved applies at the new path', () => {
    expect(
      decide(
        { op: 'modify', file_id: 'f', base_version_id: 'v1', sha: S1, size: 1, mtime: 9 },
        head({ path: 'b.md', sha: S1, baseSha: S1 }),
        settings('merge'),
        false
      )
    ).toMatchObject({ kind: 'apply', op: 'modify', path: 'b.md' })
  })
  it('9/10 modify over a changed note merges or makes a conflict file', () => {
    expect(
      decide(
        { op: 'modify', file_id: 'f', base_version_id: 'v1', sha: S1, size: 1, mtime: 9 },
        head({}),
        settings('merge'),
        false
      )
    ).toMatchObject({ kind: 'merge' })
    expect(
      decide(
        { op: 'modify', file_id: 'f', base_version_id: 'v1', sha: S1, size: 1, mtime: 9 },
        head({}),
        settings('conflict-file'),
        false
      )
    ).toMatchObject({ kind: 'conflict-file' })
  })
  it('11 modify over a changed attachment: newer mtime wins', () => {
    expect(
      decide(
        { op: 'modify', file_id: 'f', base_version_id: 'v1', sha: S1, size: 1, mtime: 9 },
        head({ kind: 'attachment', path: 'a.png' }),
        settings('merge'),
        false
      )
    ).toMatchObject({ kind: 'apply', op: 'modify' })
    expect(
      decide(
        { op: 'modify', file_id: 'f', base_version_id: 'v1', sha: S1, size: 1, mtime: 1 },
        head({ kind: 'attachment', path: 'a.png' }),
        settings('merge'),
        false
      )
    ).toMatchObject({ kind: 'head-newer', status: 'merged' })
  })
  it("11 an older modify that holds the head's own bytes loses nothing, so keeps nothing", () => {
    const current = head({ kind: 'attachment', path: 'a.png' })
    expect(
      decide(
        {
          op: 'modify',
          file_id: 'f',
          base_version_id: 'v1',
          sha: current.sha ?? '',
          size: 1,
          mtime: 1,
        },
        current,
        settings('merge'),
        false
      )
    ).toMatchObject({ kind: 'head-wins' })
  })
  it('12 delete with the head as base applies', () => {
    expect(
      decide(
        { op: 'delete', file_id: 'f', base_version_id: 'v2' },
        head({}),
        settings('merge'),
        false
      )
    ).toMatchObject({ kind: 'apply', op: 'delete' })
  })
  it('13 delete of a deleted file is a noop', () => {
    expect(
      decide(
        { op: 'delete', file_id: 'f', base_version_id: 'v1' },
        head({ deleted: true }),
        settings('merge'),
        false
      )
    ).toMatchObject({ kind: 'noop' })
  })
  it('14 delete over a changed head is head-wins', () => {
    expect(
      decide(
        { op: 'delete', file_id: 'f', base_version_id: 'v1' },
        head({}),
        settings('merge'),
        false
      )
    ).toMatchObject({ kind: 'head-wins' })
  })
  it('15 move with the head as base applies', () => {
    expect(
      decide(
        { op: 'move', file_id: 'f', base_version_id: 'v2', to_path: 'b.md' },
        head({}),
        settings('merge'),
        false
      )
    ).toMatchObject({ kind: 'apply', op: 'move', path: 'b.md', sha: S2 })
  })
  it('16 move to a taken path is rejected', () => {
    expect(
      decide(
        { op: 'move', file_id: 'f', base_version_id: 'v2', to_path: 'b.md' },
        head({}),
        settings('merge'),
        true
      )
    ).toMatchObject({ kind: 'reject', code: 'path_taken' })
  })
  it('17 move over a content-only change applies with the head blob', () => {
    expect(
      decide(
        { op: 'move', file_id: 'f', base_version_id: 'v1', to_path: 'b.md' },
        head({}),
        settings('merge'),
        false
      )
    ).toMatchObject({ kind: 'apply', op: 'move', path: 'b.md', sha: S2 })
  })
  it('18 move over a head that moved elsewhere is rejected', () => {
    expect(
      decide(
        { op: 'move', file_id: 'f', base_version_id: 'v1', to_path: 'b.md' },
        head({ path: 'c.md' }),
        settings('merge'),
        false
      )
    ).toMatchObject({ kind: 'reject', code: 'path_taken' })
  })
  it('19 move of a deleted file is not_found', () => {
    expect(
      decide(
        { op: 'move', file_id: 'f', base_version_id: 'v1', to_path: 'b.md' },
        head({ deleted: true }),
        settings('merge'),
        false
      )
    ).toMatchObject({ kind: 'reject', code: 'not_found' })
  })
  it('20 restore applies the old blob', () => {
    expect(
      decide({ op: 'restore', file_id: 'f', version_id: 'v1' }, head({}), settings('merge'), false)
    ).toMatchObject({ kind: 'apply', op: 'restore', path: 'a.md', sha: S1 })
  })
  it('20 restore of the head of a live file writes nothing', () => {
    expect(
      decide(
        { op: 'restore', file_id: 'f', version_id: 'v2' },
        head({ baseSha: S2 }),
        settings('merge'),
        false
      )
    ).toEqual({ kind: 'noop', status: 'applied' })
  })
  it('20 restore of a deleted file applies even at its own last version', () => {
    expect(
      decide(
        { op: 'restore', file_id: 'f', version_id: 'v2' },
        head({ deleted: true, baseSha: S1 }),
        settings('merge'),
        false
      )
    ).toMatchObject({ kind: 'apply', op: 'restore', sha: S1 })
  })
  it('21 unknown file is not_found', () => {
    expect(
      decide({ op: 'delete', file_id: 'x', base_version_id: 'v' }, null, settings('merge'), false)
    ).toMatchObject({ kind: 'reject', code: 'not_found' })
  })
  it('22 a base that is a version of another file is invalid_request', () => {
    const other = head({ baseIsKnown: 'other-file', baseSha: null, basePath: null })
    expect(
      decide(
        { op: 'modify', file_id: 'f', base_version_id: 'zz', sha: S1, size: 1, mtime: 9 },
        other,
        settings('merge'),
        false
      )
    ).toMatchObject({ kind: 'reject', code: 'invalid_request' })
    expect(
      decide({ op: 'delete', file_id: 'f', base_version_id: 'zz' }, other, settings('merge'), false)
    ).toMatchObject({ kind: 'reject', code: 'invalid_request' })
    expect(
      decide(
        { op: 'move', file_id: 'f', base_version_id: 'zz', to_path: 'b.md' },
        other,
        settings('merge'),
        false
      )
    ).toMatchObject({ kind: 'reject', code: 'invalid_request' })
  })

  describe('23 a base the vault has no row for is a head that changed', () => {
    const gone = (o: Partial<HeadState> = {}) =>
      head({ baseIsKnown: 'unknown', baseSha: null, basePath: null, ...o })
    const modify = { op: 'modify' as const, file_id: 'f', base_version_id: 'zz', sha: S1, size: 1 }

    it('modify of a note merges from an empty base, or copies aside in conflict-file mode', () => {
      expect(decide({ ...modify, mtime: 9 }, gone(), settings('merge'), false)).toMatchObject({
        kind: 'merge',
        path: 'a.md',
      })
      expect(
        decide({ ...modify, mtime: 9 }, gone(), settings('conflict-file'), false)
      ).toMatchObject({ kind: 'conflict-file' })
    })
    it('modify of an attachment goes to the newer mtime', () => {
      const image = gone({ kind: 'attachment', path: 'a.png' })
      expect(decide({ ...modify, mtime: 9 }, image, settings('merge'), false)).toMatchObject({
        kind: 'apply',
        op: 'modify',
        path: 'a.png',
      })
      expect(decide({ ...modify, mtime: 1 }, image, settings('merge'), false)).toMatchObject({
        kind: 'head-newer',
      })
    })
    it('modify over a deleted head still brings the file back with the new content', () => {
      expect(
        decide({ ...modify, mtime: 9 }, gone({ deleted: true }), settings('merge'), false)
      ).toMatchObject({ kind: 'apply', op: 'modify', path: 'a.md' })
    })
    it('delete is head-wins', () => {
      expect(
        decide(
          { op: 'delete', file_id: 'f', base_version_id: 'zz' },
          gone(),
          settings('merge'),
          false
        )
      ).toMatchObject({ kind: 'head-wins', status: 'merged' })
    })
    it('move applies with the head blob when the target is free, and is path_taken when not', () => {
      const move = { op: 'move' as const, file_id: 'f', base_version_id: 'zz', to_path: 'b.md' }
      expect(decide(move, gone(), settings('merge'), false)).toMatchObject({
        kind: 'apply',
        op: 'move',
        path: 'b.md',
        sha: S2,
      })
      expect(decide(move, gone(), settings('merge'), true)).toMatchObject({
        kind: 'reject',
        code: 'path_taken',
      })
      expect(decide(move, gone({ deleted: true }), settings('merge'), false)).toMatchObject({
        kind: 'reject',
        code: 'not_found',
      })
    })
    it('restore names its version outright, so an unknown one is not_found', () => {
      expect(
        decide({ op: 'restore', file_id: 'f', version_id: 'zz' }, gone(), settings('merge'), false)
      ).toMatchObject({ kind: 'reject', code: 'not_found' })
    })
  })

  describe('bytes this file has already taken in', () => {
    const png = { op: 'create' as const, path: 'a.png', sha: S1, size: 1, mtime: 1 }
    it('an older attachment whose bytes a version already holds is head-wins, not kept again', () => {
      const image = head({ kind: 'attachment', path: 'a.png', incoming: 'version' })
      expect(decide(png, image, settings('merge'), true)).toMatchObject({ kind: 'head-wins' })
      expect(decide(png, { ...image, incoming: 'merged' }, settings('merge'), true)).toMatchObject({
        kind: 'head-wins',
      })
    })
    it('a newer attachment still wins, whatever the history holds', () => {
      const image = head({ kind: 'attachment', path: 'a.png', incoming: 'version' })
      expect(decide({ ...png, mtime: 9 }, image, settings('merge'), true)).toMatchObject({
        kind: 'apply',
        op: 'modify',
      })
    })
    it('a note merged in from the same base before is head-wins, in either mode', () => {
      const note = { op: 'create' as const, path: 'a.md', sha: S1, size: 1, mtime: 1 }
      for (const mode of ['merge', 'conflict-file'] as const) {
        expect(decide(note, head({ incoming: 'merged' }), settings(mode), true)).toMatchObject({
          kind: 'head-wins',
          status: 'merged',
        })
      }
    })
    it('a note whose bytes are only an old version is merged as ever: it may be a revert', () => {
      const note = { op: 'create' as const, path: 'a.md', sha: S1, size: 1, mtime: 1 }
      expect(decide(note, head({ incoming: 'version' }), settings('merge'), true)).toMatchObject({
        kind: 'merge',
      })
    })
  })

  /**
   * A create sent while a device joins a vault it already has files
   * for carries `prefer`. The table there, cell by cell: every kind, with and without the
   * preference, against a head holding the same bytes, other bytes, and bytes this file has
   * already taken in. Whatever the preference, the loser stays a version of the file.
   */
  describe('create.prefer, for a device joining a vault', () => {
    const kinds = [
      { kind: 'note', path: 'a.md' },
      { kind: 'attachment', path: 'a.png' },
      { kind: 'settings', path: '.obsidian/app.json' },
    ] as const
    type Prefer = 'mine' | 'theirs' | undefined
    const createOf = (path: string, prefer: Prefer, mtime: number, sha = S1) => ({
      op: 'create' as const,
      path,
      sha,
      size: 1,
      mtime,
      ...(prefer === undefined ? {} : { prefer }),
    })
    const headOf = (kind: (typeof kinds)[number], o: Partial<HeadState> = {}): HeadState =>
      head({ kind: kind.kind, path: kind.path, mtime: 5, incoming: null, ...o })

    for (const k of kinds) {
      describe(k.kind, () => {
        it('the same bytes as the head are a noop, whatever the preference', () => {
          for (const prefer of [undefined, 'mine', 'theirs'] as const) {
            for (const mode of ['merge', 'conflict-file'] as const) {
              expect(
                decide(createOf(k.path, prefer, 9, S2), headOf(k), settings(mode), true)
              ).toEqual({ kind: 'noop', status: 'applied' })
            }
          }
        })

        it('mine: the op becomes the head at its path, older or newer, whatever the vault mode', () => {
          for (const mtime of [1, 9]) {
            for (const mode of ['merge', 'conflict-file'] as const) {
              for (const incoming of [null, 'version', 'merged'] as const) {
                expect(
                  decide(
                    createOf(k.path, 'mine', mtime),
                    headOf(k, { incoming }),
                    settings(mode),
                    true
                  )
                ).toEqual({
                  kind: 'apply',
                  op: 'modify',
                  path: k.path,
                  sha: S1,
                  size: 1,
                  mtime,
                  status: 'applied',
                })
              }
            }
          }
        })

        it('theirs: the head stays and the op is written as a version, older or newer', () => {
          for (const mtime of [1, 9]) {
            for (const mode of ['merge', 'conflict-file'] as const) {
              expect(
                decide(createOf(k.path, 'theirs', mtime), headOf(k), settings(mode), true)
              ).toEqual({ kind: 'head-newer', status: 'merged' })
            }
          }
        })

        it('theirs: bytes a version of the file already holds are not written again', () => {
          for (const head of [
            { incoming: 'version' as const },
            { incoming: 'merged' as const, incomingVersion: true },
          ]) {
            expect(
              decide(createOf(k.path, 'theirs', 9), headOf(k, head), settings('merge'), true)
            ).toEqual({ kind: 'head-wins', status: 'merged' })
          }
        })

        it('theirs: bytes only a merge took in are still written as a version', () => {
          expect(
            decide(
              createOf(k.path, 'theirs', 9),
              headOf(k, { incoming: 'merged' }),
              settings('merge'),
              true
            )
          ).toEqual({ kind: 'head-newer', status: 'merged' })
        })

        it('a free path is a plain create, whatever the preference', () => {
          for (const prefer of ['mine', 'theirs'] as const) {
            expect(
              decide(createOf(k.path, prefer, 1), null, settings('merge'), false)
            ).toMatchObject({ kind: 'apply', op: 'create', path: k.path, sha: S1 })
          }
        })
      })
    }

    it('no preference is the table as it was: a note merges or is copied aside', () => {
      const note = kinds[0]
      expect(
        decide(createOf(note.path, undefined, 1), headOf(note), settings('merge'), true)
      ).toEqual({ kind: 'merge', path: note.path, status: 'merged' })
      expect(
        decide(createOf(note.path, undefined, 1), headOf(note), settings('conflict-file'), true)
      ).toEqual({ kind: 'conflict-file', status: 'conflict' })
      expect(
        decide(
          createOf(note.path, undefined, 1),
          headOf(note, { incoming: 'merged' }),
          settings('merge'),
          true
        )
      ).toEqual({ kind: 'head-wins', status: 'merged' })
      expect(
        decide(
          createOf(note.path, undefined, 1),
          headOf(note, { incoming: 'version' }),
          settings('merge'),
          true
        )
      ).toEqual({ kind: 'merge', path: note.path, status: 'merged' })
    })

    it('no preference is the table as it was: anything else goes to the newer mtime', () => {
      for (const k of kinds.slice(1)) {
        expect(
          decide(createOf(k.path, undefined, 9), headOf(k), settings('merge'), true)
        ).toMatchObject({ kind: 'apply', op: 'modify', path: k.path })
        expect(decide(createOf(k.path, undefined, 1), headOf(k), settings('merge'), true)).toEqual({
          kind: 'head-newer',
          status: 'merged',
        })
        for (const incoming of ['version', 'merged'] as const) {
          expect(
            decide(createOf(k.path, undefined, 1), headOf(k, { incoming }), settings('merge'), true)
          ).toEqual({ kind: 'head-wins', status: 'merged' })
        }
      }
    })
  })
})
