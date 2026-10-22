import { expect, it, vi } from 'vitest'
const fault = vi.hoisted(() => ({
  stat: false,
  ignore: false,
  absent: false,
  file: '',
  contents: '{}',
  namespace: '',
}))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  return {
    ...actual,
    readlinkSync: (...args: Parameters<typeof actual.readlinkSync>) => {
      if (String(args[0]) === '/proc/self/ns/pid' && fault.namespace) return fault.namespace
      return actual.readlinkSync(...args)
    },
    existsSync: (path: import('node:fs').PathLike) =>
      String(path).startsWith('virtual-vault')
        ? String(path).endsWith('config.json')
        : actual.existsSync(path),
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      if (String(args[0]) === fault.file) {
        fault.file = ''
        throw Object.assign(new Error('transient identity stat'), { code: 'EIO' })
      }
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
      if (String(args[0]) === fault.file) {
        fault.file = ''
        throw Object.assign(new Error('transient evidence read'), { code: 'EIO' })
      }
      if (String(args[0]).startsWith('virtual-vault')) {
        if (fault.ignore) {
          fault.ignore = false
          throw Object.assign(new Error('transient ignore read'), { code: 'EIO' })
        }
        if (fault.absent) throw Object.assign(new Error('missing ignore'), { code: 'ENOENT' })
        return /(?:config.json|\/lock)$/.test(String(args[0])) ? fault.contents : 'private/**\n'
      }
      return actual.readFileSync(...args)
    },
  }
})
import { realTempFolder } from '../../src/nodeFsGuard.js'
import { readIgnoreText } from '../../src/replica.js'
import { readConfigDescriptor } from '../../src/config.js'
import { assertLocalSafety } from '../../src/externalSafety.js'
import {
  assertIndexedProjectionSafety,
  inspectProjectionInventory,
} from '../../src/externalDiscovery.js'
import { SqliteStateStore } from '../../src/sqliteState.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { hostname, tmpdir } from 'node:os'
import { currentBoot, localDaemon, pidNamespace } from '../../src/lock.js'

it.each(
  [2147483648, Number.MAX_SAFE_INTEGER, 1e100].flatMap((pid) => [
    { pid, namespace: '' },
    { pid, namespace: 'pid:[4026531836]' },
  ])
)(
  'D-094 rejects out-of-range lock PID $pid before probing the process (namespace $namespace)',
  ({ pid, namespace }) => {
    fault.namespace = namespace
    const ns = pidNamespace()
    fault.contents = `${pid}\n${JSON.stringify({ host: hostname(), daemon: true, ...(ns === null ? {} : { ns }) })}`
    const kill = vi.spyOn(process, 'kill')
    try {
      expect(localDaemon('virtual-vault')).toBeNull()
      expect(kill).not.toHaveBeenCalled()
    } finally {
      kill.mockRestore()
      fault.namespace = ''
      fault.contents = '{}'
    }
  }
)

it('does not infer a dead lock holder from an unknown process probe failure', () => {
  const ns = pidNamespace()
  fault.contents = `424242\n${JSON.stringify({ host: hostname(), daemon: true, ...(ns === null ? {} : { ns }) })}`
  const failure = Object.assign(new Error('process probe unavailable'), { code: 'EIO' })
  const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw failure
  })
  try {
    expect(() => localDaemon('virtual-vault')).toThrow('process probe unavailable')
  } finally {
    kill.mockRestore()
    fault.contents = '{}'
  }
})

it('does not infer a different boot from an operational boot identity read failure', () => {
  fault.file = '/proc/sys/kernel/random/boot_id'
  expect(() => currentBoot()).toThrow('transient evidence read')
})

it('does not turn an unreadable config descriptor into a legacy recovery decision', () => {
  fault.file = 'virtual-vault/.abele-sync/config.json'
  expect(() => readConfigDescriptor('virtual-vault')).toThrow('transient evidence read')
})

it('does not skip unreadable reserved configuration in the local safety check', () => {
  fault.file = 'virtual-vault/.abele-sync/config.json'
  expect(() => assertLocalSafety('virtual-vault', false, false)).toThrow()
})

it('does not erase positive projection evidence on an operational index read failure', () => {
  fault.file = 'virtual-vault/.abele-sync/projection-index.json'
  expect(() => assertIndexedProjectionSafety('virtual-vault')).toThrow('transient evidence read')
})

it('does not replace unreadable projection scope with defaults', async () => {
  fault.file = 'virtual-vault/.abele-sync/config.json'
  await expect(inspectProjectionInventory('virtual-vault')).rejects.toThrow(
    'transient evidence read'
  )
})

it('does not turn an operational ledger stat failure into an ownership mismatch', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'abele-identity-'))
  const file = join(dir, 'state.db'),
    state = SqliteStateStore.open(file)
  try {
    fault.file = file
    expect(() => state.isLedgerFile(file)).toThrow('transient identity stat')
    expect(state.isLedgerFile(file)).toBe(true)
  } finally {
    fault.file = ''
    state.close()
    await rm(dir, { recursive: true, force: true })
  }
})

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
