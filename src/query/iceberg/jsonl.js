import fs from 'node:fs'

/**
 * @import { JsonlReadResult } from './types.d.ts'
 */

/**
 * Read complete JSONL lines after a byte cursor. A trailing partial line is
 * deliberately left unread so refresh can retry it once the writer appends
 * its newline.
 *
 * @param {string} filePath
 * @param {number} startByteOffset
 * @param {number} startLineNumber
 * @returns {JsonlReadResult}
 */
export function readJsonlEntries(filePath, startByteOffset = 0, startLineNumber = 0) {
  const stat = fs.statSync(filePath)
  if (startByteOffset > stat.size) {
    throw new Error(`source JSONL was truncated: ${filePath}`)
  }
  const buf = fs.readFileSync(filePath)
  const rest = buf.subarray(startByteOffset)
  if (rest.byteLength === 0) {
    return {
      entries: [],
      nextByteOffset: startByteOffset,
      nextLineNumber: startLineNumber,
      fileSize: stat.size,
      fileMtimeMs: stat.mtimeMs,
    }
  }

  let text = rest.toString('utf8')
  const hasCompleteTail = text.endsWith('\n')
  if (!hasCompleteTail) {
    const lastNewline = text.lastIndexOf('\n')
    if (lastNewline === -1) text = ''
    else text = text.slice(0, lastNewline + 1)
  }
  if (text.length === 0) {
    return {
      entries: [],
      nextByteOffset: startByteOffset,
      nextLineNumber: startLineNumber,
      fileSize: stat.size,
      fileMtimeMs: stat.mtimeMs,
    }
  }

  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  const entries = []
  let offset = startByteOffset
  let lineNumber = startLineNumber
  for (const rawLine of lines) {
    lineNumber++
    const lineBytes = Buffer.byteLength(rawLine) + 1
    const lineOffset = offset
    const nextOffset = offset + lineBytes
    offset = nextOffset
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (!line) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        entries.push({
          lineNumber,
          byteOffset: lineOffset,
          nextByteOffset: nextOffset,
          raw: /** @type {Record<string, unknown>} */ (parsed),
        })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[collectivus] skipping malformed JSONL line ${filePath}:${lineNumber}: ${message}`)
    }
  }
  return {
    entries,
    nextByteOffset: offset,
    nextLineNumber: lineNumber,
    fileSize: stat.size,
    fileMtimeMs: stat.mtimeMs,
  }
}
