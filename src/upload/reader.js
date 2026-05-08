import fs from 'node:fs'
import readline from 'node:readline'

/**
 * Read a JSONL file line-by-line and yield each row as a parsed object.
 * Empty lines are skipped. Malformed JSON lines are skipped with a warning
 * to stderr; we'd rather upload most of the day than fail the whole job.
 *
 * @param {string} filePath
 * @returns {AsyncGenerator<Record<string, unknown>>}
 */
export async function* readJsonlRows(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  let lineno = 0
  for await (const line of rl) {
    lineno++
    if (!line) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        yield /** @type {Record<string, unknown>} */ (parsed)
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[collectivus] skipping malformed JSONL line ${filePath}:${lineno}: ${message}`)
    }
  }
}
