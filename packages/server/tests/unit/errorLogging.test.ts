import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import { errorHandler } from '../../src/api/errors.js'
import { operationalLog } from '../../src/api/operationalLog.js'

it('bounds repeated internal-error logs and omits attacker-controlled request URLs', async () => {
  const app = Fastify({ logger: false })
  app.setErrorHandler(errorHandler)
  app.get('/fault', async () => {
    throw new Error('synthetic fault ' + 'x'.repeat(10000))
  })
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    for (let i = 0; i < 20; i++) {
      expect((await app.inject('/fault?secret=must-not-be-logged')).statusCode).toBe(500)
    }
    expect(logged).toHaveBeenCalledOnce()
    const output = logged.mock.calls.flat().map(String).join(' ')
    expect(output.length).toBeLessThanOrEqual(1200)
    expect(output).not.toContain('must-not-be-logged')
  } finally {
    logged.mockRestore()
    await app.close()
  }
})

it('caps distinct faults as well as repeats and resumes diagnostics after the window', () => {
  const owner = {}
  const clock = vi.spyOn(Date, 'now').mockReturnValue(100000)
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    for (let i = 0; i < 100; i++) operationalLog(owner, 'request failed', new Error('fault ' + i))
    expect(logged).toHaveBeenCalledTimes(10)
    clock.mockReturnValue(160000)
    operationalLog(owner, 'request failed', new Error('fault 0'))
    expect(logged).toHaveBeenCalledTimes(11)
  } finally {
    clock.mockRestore()
    logged.mockRestore()
  }
})
