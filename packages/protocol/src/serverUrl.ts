/**
 * Which server addresses a device may sync with. One rule shared by the plugin
 * and the daemon: https anywhere, plain http only to a server on this device.
 * A device token travels in every request, so plain http to another machine
 * hands it to anyone on the path.
 */

/** The one message every refused plain-http address gets. */
export const PLAIN_HTTP_REFUSED =
  'Plain http is only allowed for a server on this device (localhost, 127.0.0.1, ::1). Use an https:// address.'

const NO_SCHEME = 'add https:// in front of the address'
const OTHER_SCHEME = 'Use an https:// address.'
const UNPARSABLE = 'that is not a web address; use an https:// address'

/** `scheme://`, checked before parsing: `URL` reads `localhost:8787` as scheme `localhost:`. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
/** A loopback IPv4 address as `URL` normalises it (so `127.1` has become `127.0.0.1`). */
const LOOPBACK_V4 = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

/**
 * Why a device must not sync with `url`, or null when it may. The scheme and the
 * host are judged; a path prefix is fine, since a reverse proxy may mount the
 * server under one.
 *
 * An address carrying userinfo (`user@`), a query, a fragment or a backslash is
 * not an address at all here. `URL` reads the host of `http://localhost\@evil.com`
 * as `localhost`, but a stricter parser — a phone's native HTTP stack — reads
 * `evil.com`, and the rule would have judged a host the request never goes to.
 * A query or fragment in the base would also swallow every path appended to it.
 */
export function serverUrlProblem(url: string): string | null {
  const judged = judge(url)
  return typeof judged === 'string' ? judged : null
}

/**
 * The address to store for `url`, or null when the rule refuses it: its origin
 * and path as `URL` reads them — scheme and host lower-cased, a default port
 * dropped, a loopback address in its one spelling — with no trailing slash.
 * Storing this rather than what was typed means the host that was judged is the
 * host every request goes to, whatever parser sends it.
 */
export function normalizeServerUrl(url: string): string | null {
  const judged = judge(url)
  if (typeof judged === 'string') return null
  return `${judged.origin}${judged.pathname.replace(/\/+$/, '')}`
}

/** The parsed address when the rule allows it, else the reason it does not. */
function judge(url: string): URL | string {
  const text = url.trim()
  if (text === '') return UNPARSABLE
  if (!HAS_SCHEME.test(text)) return NO_SCHEME
  if (text.includes('\\')) return UNPARSABLE
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    return UNPARSABLE
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return OTHER_SCHEME
  if (parsed.hostname === '') return UNPARSABLE
  if (parsed.username !== '' || parsed.password !== '') return UNPARSABLE
  // `search` and `hash` are '' for a bare `?` or `#` as well, so the text is asked too.
  if (parsed.search !== '' || parsed.hash !== '' || /[?#]/.test(text)) return UNPARSABLE
  if (parsed.protocol === 'http:' && !isThisDevice(parsed.hostname)) return PLAIN_HTTP_REFUSED
  return parsed
}

/**
 * Whether a hostname (already lower-cased by `URL`) names this device. Only the
 * literal loopback names count: `0.0.0.0`, `*.localhost` and anything that
 * resolves through DNS are refused, since resolving is where a name can lie.
 */
function isThisDevice(hostname: string): boolean {
  const host = hostname.replace(/^\[(.*)\]$/, '$1')
  return host === 'localhost' || host === '::1' || LOOPBACK_V4.test(host)
}
