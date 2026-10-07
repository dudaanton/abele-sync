#!/usr/bin/env node
import { runCli } from './cli.js'
import { processExitCode } from './context.js'

/**
 * The program's shell: the arguments, the environment, the console and the host's own
 * transports, and the exit code `runCli` decided on.
 *
 * `process.exit` rather than falling off the end: a daemon that has just been stopped may
 * still hold a socket or a database handle a moment longer, and the code has been decided
 * either way.
 */
const code = await runCli(process.argv.slice(2), process.env, {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  fetch: globalThis.fetch,
  WebSocket: globalThis.WebSocket,
  stdin: process.stdin,
  stderr: process.stderr,
})
process.exit(processExitCode(code, process.env))
