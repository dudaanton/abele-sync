import { createInterface } from 'node:readline'
import { UsageError, type PromptInput } from './context.js'

/**
 * One line from a person at the terminal, trimmed and lower-cased; the question goes to
 * `output`. Input that ends before a line is a usage error saying `noAnswer`, which names the
 * flag a script would pass instead.
 */
export function promptLine(
  input: PromptInput,
  output: NodeJS.WritableStream,
  question: string,
  noAnswer: string
): Promise<string> {
  const rl = createInterface({ input, terminal: false })
  output.write(question)
  return new Promise<string>((resolve, reject) => {
    rl.once('close', () => reject(new UsageError(noAnswer)))
    rl.once('line', (line) => {
      rl.removeAllListeners('close')
      rl.close()
      resolve(line.trim().toLowerCase())
    })
  })
}
