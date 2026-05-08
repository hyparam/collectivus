import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * @import { FileHandle } from 'node:fs/promises'
 */

/**
 * JSONL file sink. One row per line, appended to `<dir>/proxy.jsonl`. Writes
 * are serialized so rows land in submission order even under concurrent
 * callers. The directory is created lazily on the first write so a sink can
 * be constructed eagerly without side effects.
 */
export class FileSink {
  /** @param {string} dir */
  constructor(dir) {
    /** @type {string} */
    this.dir = dir
    /** @type {string} */
    this.filePath = path.join(dir, 'proxy.jsonl')
    /** @type {FileHandle | undefined} */
    this.fh = undefined
    /** @type {Promise<void>} */
    this.queue = Promise.resolve()
    /** @type {boolean} */
    this.closed = false
  }

  /**
   * Append one JSONL row. Resolves after the row has been written to the
   * underlying file (kernel-side; not yet fsynced).
   *
   * @param {unknown} obj
   * @returns {Promise<void>}
   */
  writeRow(obj) {
    if (this.closed) return Promise.reject(new Error('FileSink: writeRow after close'))
    const line = JSON.stringify(obj) + '\n'
    const result = this.queue.then(
      () => writeLine(this, line),
      () => writeLine(this, line)
    )
    // Detach the chain head from the caller-visible promise so a failure on
    // one row does not surface as an unhandled rejection on the next.
    this.queue = result.catch(() => {})
    return result
  }

  /**
   * Flush, fsync, and close the underlying file. Idempotent: subsequent
   * calls resolve immediately and additional writes throw.
   *
   * @returns {Promise<void>}
   */
  async close() {
    if (this.closed) return
    this.closed = true
    try {
      await this.queue
    } catch {
      // surfaced to the caller of writeRow already
    }
    if (this.fh !== undefined) {
      const { fh } = this
      this.fh = undefined
      try {
        await fh.sync()
      } finally {
        await fh.close()
      }
    }
  }
}

/**
 * @param {FileSink} sink
 * @param {string} line
 * @returns {Promise<void>}
 */
async function writeLine(sink, line) {
  if (sink.fh === undefined) {
    await fs.mkdir(sink.dir, { recursive: true })
    sink.fh = await fs.open(sink.filePath, 'a')
  }
  await sink.fh.write(line)
}
