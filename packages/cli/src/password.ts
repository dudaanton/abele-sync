import { createInterface } from 'node:readline'
import { Writable } from 'node:stream'
import type { PromptInput } from './context.js'

/**
 * A password asked for at the terminal, with nothing echoed.
 *
 * readline is given a sink to write to, so what is typed is never shown; the question itself
 * goes straight to the real output, and so does the line break the user's Enter would have
 * drawn. Only ever called with a TTY on the other end: a script with no terminal gets the
 * usage error that names `--password` and `ABELE_PASSWORD` instead of a prompt nobody answers.
 */
export function promptPassword(
  input: PromptInput,
  output: NodeJS.WritableStream,
  question = 'password: '
): Promise<string> {
  const muted = new Writable({ write: (_chunk, _encoding, done) => done() })
  const rl = createInterface({ input, output: muted, terminal: true })
  output.write(question)
  return new Promise((resolve, reject) => {
    rl.once('close', () => {
      // Closed before an answer: end of input, or a Ctrl-C readline turned into a close.
      reject(new Error('no password was entered'))
    })
    rl.question('', (answer) => {
      rl.removeAllListeners('close')
      rl.close()
      output.write('\n')
      resolve(answer)
    })
  })
}
