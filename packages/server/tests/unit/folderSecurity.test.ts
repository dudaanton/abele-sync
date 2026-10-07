import { describe, expect, it } from 'vitest'
import {
  folderEligibility,
  folderMutation,
  folderTransition,
  reduceSecurity,
} from '../../src/scoped/folderSecurity.js'

const ordinary = { executable: 0 as const, settings: 0 as const }
const note = (
  path: string,
  security: typeof ordinary | { executable: null; settings: null } = ordinary
) => ({
  path,
  kind: 'note' as const,
  security: {
    ...security,
    source_namespaces: JSON.stringify([
      path.includes('/') ? path.split('/')[0]!.toLowerCase() : '/',
    ]),
  },
})
describe('folder/security reducer', () => {
  it('matches canonical paths on segment boundaries, without prefix stripping or traversal repair', () => {
    for (const path of ['Agents/note.md', 'Agents/sub/note.md', 'AGENTS/sub/Note.md'])
      expect(folderEligibility('Agents/', note(path)).eligible).toBe(true)
    for (const path of [
      'Agents-private/note.md',
      'Agents',
      'Private/note.md',
      '/Agents/note.md',
      'Agents/../Private/note.md',
      'Agents\\note.md',
      'Agents//note.md',
    ])
      expect(folderEligibility('Agents/', note(path)).eligible).toBe(false)
    expect(note('Agents/sub/note.md').path).toBe('Agents/sub/note.md')
  })
  it('authorizes both sides of a recipient mutation and treats owner scope departure separately from deletion', () => {
    expect(
      folderMutation('Agents/', 'move', note('Agents/x.md'), note('Private/x.md')).eligible
    ).toBe(false)
    expect(
      folderMutation('Agents/', 'modify', note('Private/x.md'), note('Agents/x.md')).eligible
    ).toBe(false)
    expect(folderTransition('Agents/', note('Agents/x.md'), note('Private/x.md'))).toBe('leave')
    expect(folderTransition('Agents/', note('Private/x.md'), note('Agents/x.md'))).toBe('enter')
    expect(folderMutation('Agents/', 'create', null, note('Agents/x.md')).eligible).toBe(true)
  })
  it('denies default/registered settings, code, reserved state and known local symlink escape', () => {
    for (const path of [
      '.obsidian/app.json',
      '.trash/note.md',
      '.abele-sync/state.db',
      'Config/plugins/main.png',
    ]) {
      expect(
        folderEligibility('Config/', note(path), { configurationDirectories: ['Config'] }).eligible
      ).toBe(false)
    }
    expect(
      folderEligibility('Agents/', {
        ...note('Agents/image.png'),
        security: { executable: 1, settings: 0, source_namespaces: null },
      }).reason
    ).toBe('executable')
    expect(
      folderEligibility('Agents/', {
        ...note('Agents/source.JS'),
        security: { ...ordinary, source_namespaces: null },
      }).reason
    ).toBe('executable')
    expect(
      folderEligibility('Agents/', { ...note('Agents/x.md'), withinLocalRoot: false }).reason
    ).toBe('local_escape')
  })
  it('never lets a renamed executable/settings source or an unknown restore become ordinary', () => {
    expect(
      reduceSecurity('Agents/image.png', 'attachment', [{ executable: 1, settings: 0 }], false)
    ).toEqual({ executable: 1, settings: 0 })
    expect(
      reduceSecurity('Agents/note.md', 'note', [{ executable: 0, settings: 1 }], false)
    ).toEqual({ executable: 0, settings: 1 })
    expect(reduceSecurity('Agents/note.md', 'note', [null], false)).toEqual({
      executable: null,
      settings: null,
    })
    expect(reduceSecurity('Agents/note.md', 'note', [], false)).toEqual({
      executable: null,
      settings: null,
    })
    expect(reduceSecurity('Agents/note.md', 'note', [], true)).toEqual(ordinary)
  })
  it('holds only the unknown file and never parses content for folder eligibility', () => {
    const unknown = {
      ...note('Agents/legacy.md'),
      security: { executable: null, settings: null, source_namespaces: null },
      get content(): never {
        throw new Error('scope must not parse YAML/Markdown')
      },
    }
    expect(folderEligibility('Agents/', unknown).reason).toBe('security_unknown')
    expect(
      folderEligibility('Agents/', {
        ...note('Agents/current.md'),
        get content(): never {
          throw new Error('no body parser')
        },
      }).eligible
    ).toBe(true)
  })
})
