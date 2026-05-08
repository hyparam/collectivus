/**
 * Hand-rolled SSE (Server-Sent Events) parser per the WHATWG eventsource
 * grammar. Stateful and chunk-friendly: feed bytes as they arrive, get back
 * complete events as they become dispatchable. No dependencies.
 */

/**
 * @import { SseEvent } from './types.js'
 */

/**
 * Streaming SSE parser. Holds an internal buffer so events that span chunk
 * boundaries are reassembled and dispatched on the next blank-line terminator.
 */
export class SseParser {
  constructor() {
    /** @type {string} */
    this.buffer = ''
  }

  /**
   * Feed a chunk of the SSE byte stream and return any complete events that
   * became dispatchable. Bytes from a partial trailing event remain in the
   * internal buffer for the next call.
   *
   * @param {string | Buffer} chunk
   * @returns {SseEvent[]}
   */
  feed(chunk) {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    /** @type {SseEvent[]} */
    const events = []
    while (true) {
      const sep = findSeparator(this.buffer)
      if (sep === -1) break
      const block = this.buffer.slice(0, sep.idx)
      this.buffer = this.buffer.slice(sep.idx + sep.len)
      const ev = parseBlock(block)
      if (ev) events.push(ev)
    }
    return events
  }
}

/**
 * Whether response headers indicate an SSE stream. Matches `text/event-stream`
 * with optional charset / parameters and is case-insensitive.
 *
 * @param {Record<string, string | string[] | undefined>} headers
 * @returns {boolean}
 */
export function isSseHeaders(headers) {
  const ct = headers['content-type'] ?? headers['Content-Type']
  const value = Array.isArray(ct) ? ct[0] : ct
  if (typeof value !== 'string') return false
  return value.toLowerCase().split(';')[0].trim() === 'text/event-stream'
}

/**
 * Find the next event separator — `\n\n` or `\r\n\r\n`. Returns the offset
 * and length of the terminator so the caller can slice the preceding event
 * block and advance the buffer past it.
 *
 * @param {string} buf
 * @returns {{ idx: number, len: number } | -1}
 */
function findSeparator(buf) {
  const a = buf.indexOf('\n\n')
  const b = buf.indexOf('\r\n\r\n')
  if (a === -1 && b === -1) return -1
  if (a === -1) return { idx: b, len: 4 }
  if (b === -1) return { idx: a, len: 2 }
  if (a < b) return { idx: a, len: 2 }
  return { idx: b, len: 4 }
}

/**
 * Parse a single event block per the WHATWG eventsource grammar — fields are
 * `field: value` lines, multiple `data:` lines concatenate with `\n`, the
 * default event type is `message`, lines starting with `:` are comments, and
 * blocks containing only comments dispatch nothing.
 *
 * @param {string} block
 * @returns {SseEvent | undefined}
 */
function parseBlock(block) {
  let event = 'message'
  let data = ''
  let hasField = false
  const lines = block.split(/\r?\n/)
  for (const line of lines) {
    if (line.length === 0) continue
    if (line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'event') {
      event = value
      hasField = true
    } else if (field === 'data') {
      data = data.length === 0 ? value : `${data}\n${value}`
      hasField = true
    } else if (field === 'id' || field === 'retry') {
      // Recognized but ignored — they don't change event/data, but their
      // presence still counts as field content (spec dispatches the block).
      hasField = true
    }
  }
  if (!hasField) return undefined
  return { event, data }
}
