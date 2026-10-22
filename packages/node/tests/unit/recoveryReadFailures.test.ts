import { expect, it, vi } from 'vitest'
const fault = vi.hoisted(() => ({ stat: false, ignore: false, absent: false }))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  return {
    ...actual,
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      if (String(args[0]).startsWith('virtual-vault')) {
        if (fault.stat) {
          fault.stat = false
          throw Object.assign(new Error('transient stat'), { code: 'EIO' })
        }
        return { isDirectory: () => true }
      }
      return actual.lstatSync(...args)
    },
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (String(args[0]).startsWith('virtual-vault')) {
        if (fault.ignore) {
          fault.ignore = false
          throw Object.assign(new Error('transient ignore read'), { code: 'EIO' })
        }
        if (fault.absent) throw Object.assign(new Error('missing ignore'), { code: 'ENOENT' })
        return 'private/**\n'
      }
      return actual.readFileSync(...args)
    },
  }
})
import { realTempFolder } from '../../src/nodeFsGuard.js'
import { readIgnoreText } from '../../src/replica.js'

it('does not classify a transient recovery-directory stat failure as an absent group folder', () => {
  fault.stat = true
  expect(() => realTempFolder('virtual-vault', '.abele-sync', 'code-approvals')).toThrow(
    'transient stat'
  )
  expect(realTempFolder('virtual-vault', '.abele-sync', 'code-approvals')).toBe(
    'virtual-vault/.abele-sync/code-approvals'
  )
})

it('does not classify a transient ignore read failure as a scope without exclusions', () => {
  fault.ignore = true
  fault.absent = false
  expect(() => readIgnoreText('virtual-vault')).toThrow('transient ignore read')
  expect(readIgnoreText('virtual-vault')).toBe('private/**\n')
  fault.absent = true
  expect(readIgnoreText('virtual-vault')).toBeNull()
  fault.absent = false
})
