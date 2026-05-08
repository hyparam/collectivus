import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FileSink } from '../../src/sinks/file.js'

/** @type {string} */
let tmpDir

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-sink-'))
})

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/**
 * @param {string} dir
 * @returns {unknown[]}
 */
function readJsonl(dir) {
  const file = path.join(dir, 'proxy.jsonl')
  if (!fs.existsSync(file)) return []
  const text = fs.readFileSync(file, 'utf8')
  if (text.length === 0) return []
  return text
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line))
}

describe('FileSink', () => {
  it('appends one row per line to <dir>/proxy.jsonl', async () => {
    const sink = new FileSink(tmpDir)
    await sink.writeRow({ a: 1 })
    await sink.writeRow({ a: 2 })
    await sink.close()
    expect(readJsonl(tmpDir)).toEqual([{ a: 1 }, { a: 2 }])
  })

  it('creates the target directory lazily on first write', async () => {
    const nested = path.join(tmpDir, 'nested', 'further')
    expect(fs.existsSync(nested)).toBe(false)
    const sink = new FileSink(nested)
    expect(fs.existsSync(nested)).toBe(false)
    await sink.writeRow({ ok: true })
    await sink.close()
    expect(fs.existsSync(nested)).toBe(true)
    expect(readJsonl(nested)).toEqual([{ ok: true }])
  })

  it('preserves submission order under concurrent writeRow calls', async () => {
    const sink = new FileSink(tmpDir)
    const writes = []
    for (let i = 0; i < 50; i++) writes.push(sink.writeRow({ i }))
    await Promise.all(writes)
    await sink.close()
    const rows = readJsonl(tmpDir)
    /** @type {{ i: number }[]} */
    const typedRows = []
    for (const row of rows) {
      if (typeof row === 'object' && row !== null && 'i' in row && typeof row.i === 'number') {
        typedRows.push({ i: row.i })
      }
    }
    expect(typedRows.map((row) => row.i)).toEqual(Array.from({ length: 50 }, (_, i) => i))
  })

  it('accepts close() with no writes and creates no file', async () => {
    const sink = new FileSink(tmpDir)
    await sink.close()
    expect(fs.existsSync(path.join(tmpDir, 'proxy.jsonl'))).toBe(false)
  })

  it('rejects writeRow after close', async () => {
    const sink = new FileSink(tmpDir)
    await sink.writeRow({ a: 1 })
    await sink.close()
    await expect(sink.writeRow({ a: 2 })).rejects.toThrow(/after close/)
  })

  it('close() is idempotent', async () => {
    const sink = new FileSink(tmpDir)
    await sink.writeRow({ a: 1 })
    await sink.close()
    await sink.close()
    expect(readJsonl(tmpDir)).toEqual([{ a: 1 }])
  })

  it('appends across separate sink instances (does not truncate existing file)', async () => {
    const a = new FileSink(tmpDir)
    await a.writeRow({ run: 1 })
    await a.close()
    const b = new FileSink(tmpDir)
    await b.writeRow({ run: 2 })
    await b.close()
    expect(readJsonl(tmpDir)).toEqual([{ run: 1 }, { run: 2 }])
  })

  it('persists writes that occur right before close (fsync-on-close)', async () => {
    // Fire writeRow without awaiting individually — close() must drain the queue.
    const sink = new FileSink(tmpDir)
    sink.writeRow({ i: 1 })
    sink.writeRow({ i: 2 })
    sink.writeRow({ i: 3 })
    await sink.close()
    expect(readJsonl(tmpDir)).toEqual([{ i: 1 }, { i: 2 }, { i: 3 }])
  })
})
