import { describe, it, expect } from 'vitest'
import { normalizeServerUrl, PLAIN_HTTP_REFUSED, serverUrlProblem } from '../src/serverUrl.js'

describe('serverUrlProblem', () => {
  const allowed = [
    'https://sync.example.com',
    'https://sync.example.com/',
    'https://sync.example.com:8443/abele/',
    'https://192.168.1.5',
    'http://localhost',
    'http://localhost:8787',
    'HTTP://LOCALHOST',
    'http://LocalHost:8787/',
    'http://127.0.0.1',
    'http://127.0.0.1:8787',
    'http://127.12.34.56:9000/prefix/',
    'http://[::1]:8787',
    'http://[::1]',
    'http://localhost:8787/behind/a/proxy',
  ]
  for (const url of allowed) {
    it(`allows ${url}`, () => {
      expect(serverUrlProblem(url)).toBeNull()
    })
  }

  const plainHttp = [
    'http://192.168.1.5',
    'http://192.168.1.5:8787',
    'http://10.0.0.2',
    'http://0.0.0.0:8787',
    'http://app.localhost',
    'http://localhost.example.com',
    'http://sync.example.com',
    'http://128.0.0.1',
    'http://[::2]',
    'http://[fe80::1]',
    'http://[::ffff:127.0.0.1]',
  ]
  for (const url of plainHttp) {
    it(`refuses plain http to ${url}`, () => {
      expect(serverUrlProblem(url)).toBe(PLAIN_HTTP_REFUSED)
    })
  }

  it('asks for a scheme when none is given', () => {
    expect(serverUrlProblem('sync.example.com')).toBe('add https:// in front of the address')
    expect(serverUrlProblem('localhost:8787')).toBe('add https:// in front of the address')
    expect(serverUrlProblem('192.168.1.5:8787')).toBe('add https:// in front of the address')
  })

  it('refuses any other scheme', () => {
    for (const url of ['ftp://sync.example.com', 'ws://localhost:8787', 'file:///tmp/x']) {
      expect(serverUrlProblem(url)).toMatch(/https/)
      expect(serverUrlProblem(url)).not.toBeNull()
    }
  })

  it('refuses an empty or unparsable address', () => {
    expect(serverUrlProblem('')).not.toBeNull()
    expect(serverUrlProblem('   ')).not.toBeNull()
    expect(serverUrlProblem('https://')).not.toBeNull()
  })

  // Userinfo, a query, a fragment or a backslash: WHATWG `URL` reads the host as loopback,
  // but a stricter parser on a phone's native stack may read another host out of the same
  // text, and a query or fragment in the base would swallow every request path.
  const notAnAddress = [
    'http://localhost\\@evil.com',
    'http://127.0.0.1\\@evil.com',
    'https://sync.example.com\\@evil.com',
    'http://evil.com@localhost',
    'http://user:pw@localhost:8787',
    'http://localhost#@evil.com',
    'http://localhost?@evil.com',
    'https://user:pw@evil.com',
    'https://sync.example.com/?x=1',
    'https://sync.example.com/#top',
    'https://sync.example.com?',
    'https://sync.example.com#',
  ]
  for (const url of notAnAddress) {
    it(`refuses ${url} as not a web address`, () => {
      expect(serverUrlProblem(url)).toBe('that is not a web address; use an https:// address')
    })
  }

  it('reads the message it names', () => {
    expect(PLAIN_HTTP_REFUSED).toBe(
      'Plain http is only allowed for a server on this device (localhost, 127.0.0.1, ::1). Use an https:// address.'
    )
  })
})

describe('normalizeServerUrl', () => {
  const cases: [string, string][] = [
    ['https://sync.example.com', 'https://sync.example.com'],
    ['https://sync.example.com/', 'https://sync.example.com'],
    ['  https://Sync.Example.com:443/  ', 'https://sync.example.com'],
    ['https://sync.example.com:8443/abele/', 'https://sync.example.com:8443/abele'],
    ['https://sync.example.com/abele//', 'https://sync.example.com/abele'],
    ['HTTP://LOCALHOST:8787', 'http://localhost:8787'],
    ['http://127.1:8787', 'http://127.0.0.1:8787'],
    ['http://[0:0:0:0:0:0:0:1]:8787/', 'http://[::1]:8787'],
  ]
  for (const [input, stored] of cases) {
    it(`stores ${input} as ${stored}`, () => {
      expect(normalizeServerUrl(input)).toBe(stored)
    })
  }

  it('has nothing to store for an address the rule refuses', () => {
    for (const url of ['http://192.168.1.5', 'localhost:8787', 'http://evil.com@localhost', '']) {
      expect(normalizeServerUrl(url)).toBeNull()
    }
  })
})
