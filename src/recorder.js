import { randomBytes } from 'node:crypto'

/** @typedef {import('./sinks/file.js').Sink} Sink */

/**
 * Headers redacted by default. Operators can extend this set per-config; this
 * list cannot be shrunk because these specifically carry credentials or
 * session state that must never appear verbatim in recordings.
 */
const DEFAULT_REDACT_HEADERS = [
  'authorization',
  'x-api-key',
  'anthropic-api-key',
  'cookie',
  'set-cookie',
]

/**
 * @typedef {object} ClientInfo
 * @property {string | undefined} ip - Client remote address as observed by the proxy.
 * @property {string | undefined} user_agent - Client User-Agent header value.
 */

/**
 * @typedef {object} ExchangeRequest
 * @property {string | undefined} method - HTTP method (e.g. 'POST').
 * @property {string | undefined} path - Path + query as received.
 * @property {Record<string, string | string[] | undefined>} headers - Headers post-redaction.
 * @property {string} body - Request body as received (utf-8). Empty string for requests with no body.
 */

/**
 * @typedef {object} ExchangeResponse
 * @property {number | undefined} status - HTTP status from upstream.
 * @property {Record<string, string | string[] | undefined>} headers - Response headers post-redaction.
 * @property {string | null} body - Response body for non-streaming responses; `null` for SSE (events recorded separately).
 */

/**
 * Recorder factory. Holds the redact configuration and the sink used to
 * persist rows. Per-exchange state lives on the {@link Exchange} instance
 * returned by {@link Recorder#startExchange}.
 */
export class Recorder {
  /**
   * @param {{ sink: Sink, redactHeaders?: readonly string[] | undefined }} options
   */
  constructor(options) {
    if (!options || !options.sink) throw new Error('Recorder: sink is required')
    /** @type {Sink} */
    this.sink = options.sink
    /** @type {Set<string>} */
    this.redactSet = buildRedactSet(options.redactHeaders)
  }

  /**
   * Begin recording a new exchange. The returned object collects state and
   * writes the final `exchange` row when {@link Exchange#finish} is called.
   *
   * @param {{
   *   upstream: string,
   *   client: ClientInfo,
   *   request: { method: string | undefined, path: string | undefined, headers: Record<string, string | string[] | undefined> },
   * }} init
   * @returns {Exchange}
   */
  startExchange(init) {
    return new Exchange(this, init)
  }
}

/**
 * Mutable state for one in-flight request/response pair.
 */
export class Exchange {
  /**
   * @param {Recorder} recorder
   * @param {{
   *   upstream: string,
   *   client: ClientInfo,
   *   request: { method: string | undefined, path: string | undefined, headers: Record<string, string | string[] | undefined> },
   * }} init
   */
  constructor(recorder, init) {
    /** @type {Recorder} */
    this.recorder = recorder
    /** @type {string} */
    this.id = randomBytes(16).toString('hex')
    /** @type {number} */
    this.tsStartMs = Date.now()
    /** @type {string} */
    this.tsStart = new Date(this.tsStartMs).toISOString()
    /** @type {string} */
    this.upstream = init.upstream
    /** @type {ClientInfo} */
    this.client = init.client
    /** @type {Buffer[]} */
    this.requestChunks = []
    /** @type {Record<string, string | string[] | undefined>} */
    this.requestHeaders = redactHeaders(init.request.headers, recorder.redactSet)
    /** @type {string | undefined} */
    this.requestMethod = init.request.method
    /** @type {string | undefined} */
    this.requestPath = init.request.path
    /** @type {ExchangeResponse | null} */
    this.response = null
    /** @type {number} */
    this.streamEventCount = 0
    /** @type {string | null} */
    this.error = null
    /** @type {boolean} */
    this.finished = false
    /** @type {string} */
    this.sseBuffer = ''
  }

  /**
   * Record a single chunk of the inbound request body. Called by the proxy
   * for every `data` event on the client request.
   *
   * @param {Buffer} chunk
   * @returns {void}
   */
  appendRequestChunk(chunk) {
    this.requestChunks.push(chunk)
  }

  /**
   * Record the response start. For non-streaming responses the proxy also
   * calls {@link Exchange#appendResponseChunk}; for SSE the chunks are fed
   * through {@link Exchange#consumeStreamChunk}.
   *
   * @param {{ status: number | undefined, headers: Record<string, string | string[] | undefined> }} init
   * @returns {void}
   */
  setResponseStart(init) {
    this.response = {
      status: init.status,
      headers: redactHeaders(init.headers, this.recorder.redactSet),
      body: '',
    }
  }

  /**
   * Append a chunk of a non-streaming response body. The proxy collects
   * chunks here so the exchange row carries the full body.
   *
   * @param {Buffer} chunk
   * @returns {void}
   */
  appendResponseChunk(chunk) {
    if (!this.response) return
    if (this.response.body === null) return
    this.response.body += chunk.toString('utf8')
  }

  /**
   * Mark this exchange as a streaming exchange. Drops any non-streaming body
   * accumulator (we'll record per-event rows instead).
   *
   * @returns {void}
   */
  markStreaming() {
    if (!this.response) return
    this.response.body = null
  }

  /**
   * Feed a chunk of an SSE response into the stream parser. Complete events
   * are emitted as `stream_event` rows. Returns the promise of the writes
   * scheduled by this chunk (rarely awaited; useful for tests).
   *
   * @param {Buffer} chunk
   * @returns {Promise<void>}
   */
  async consumeStreamChunk(chunk) {
    this.sseBuffer += chunk.toString('utf8')
    /** @type {Promise<void>[]} */
    const writes = []
    while (true) {
      const sep = findSseSeparator(this.sseBuffer)
      if (sep === -1) break
      const block = this.sseBuffer.slice(0, sep.idx)
      this.sseBuffer = this.sseBuffer.slice(sep.idx + sep.len)
      const ev = parseSseBlock(block)
      if (ev) {
        this.streamEventCount += 1
        writes.push(this.recorder.sink.writeRow({
          exchange_id: this.id,
          kind: 'stream_event',
          t_ms: Date.now() - this.tsStartMs,
          event: ev.event,
          data: ev.data,
        }))
      }
    }
    await Promise.all(writes)
  }

  /**
   * Mark this exchange as failed. Subsequent calls overwrite earlier errors
   * — the most recent failure typically carries the most useful context
   * (e.g. an upstream error after a partial response).
   *
   * @param {unknown} err
   * @returns {void}
   */
  setError(err) {
    if (err instanceof Error) {
      this.error = err.message || err.name || 'unknown error'
    } else if (typeof err === 'string') {
      this.error = err
    } else {
      this.error = String(err)
    }
  }

  /**
   * Write the final `exchange` row. Idempotent — calling twice is a no-op so
   * the proxy can call it from multiple completion paths (response end,
   * client abort, upstream error) without double-writing.
   *
   * @returns {Promise<void>}
   */
  async finish() {
    if (this.finished) return
    this.finished = true

    const tsEndMs = Date.now()
    const requestBody = Buffer.concat(this.requestChunks).toString('utf8')

    const row = {
      exchange_id: this.id,
      kind: 'exchange',
      ts_start: this.tsStart,
      ts_end: new Date(tsEndMs).toISOString(),
      duration_ms: tsEndMs - this.tsStartMs,
      upstream: this.upstream,
      client: this.client,
      request: {
        method: this.requestMethod,
        path: this.requestPath,
        headers: this.requestHeaders,
        body: requestBody,
      },
      response: this.response,
      stream_event_count: this.streamEventCount,
      error: this.error,
    }
    await this.recorder.sink.writeRow(row)
  }
}

/**
 * Return true if the given response headers indicate an SSE stream. Anything
 * starting with `text/event-stream` (with optional charset / parameters) is
 * treated as a stream.
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
 * @param {readonly string[] | undefined} extra
 * @returns {Set<string>}
 */
function buildRedactSet(extra) {
  const out = new Set(DEFAULT_REDACT_HEADERS)
  if (extra) {
    for (const name of extra) {
      if (typeof name === 'string' && name.length > 0) {
        out.add(name.toLowerCase())
      }
    }
  }
  return out
}

/**
 * @param {Record<string, string | string[] | undefined>} headers
 * @param {Set<string>} redactSet
 * @returns {Record<string, string | string[] | undefined>}
 */
function redactHeaders(headers, redactSet) {
  /** @type {Record<string, string | string[] | undefined>} */
  const out = {}
  for (const key of Object.keys(headers)) {
    const value = headers[key]
    if (value === undefined) continue
    if (redactSet.has(key.toLowerCase())) {
      out[key] = redactValue(value)
    } else {
      out[key] = value
    }
  }
  return out
}

/**
 * Replace a header value with `REDACTED:<last4>`. Arrays (e.g. multi-value
 * `Set-Cookie`) are mapped element-wise so each entry is independently
 * recoverable by its tail without leaking the full value.
 *
 * @param {string | string[]} value
 * @returns {string | string[]}
 */
function redactValue(value) {
  if (Array.isArray(value)) return value.map((v) => redactString(v))
  return redactString(value)
}

/**
 * @param {string} value
 * @returns {string}
 */
function redactString(value) {
  if (typeof value !== 'string') return 'REDACTED:'
  const tail = value.length >= 4 ? value.slice(-4) : value
  return `REDACTED:${tail}`
}

/**
 * Find the next SSE event separator — `\n\n` or `\r\n\r\n`. Returns the
 * starting offset and length of the separator so the caller can slice the
 * preceding event block and advance past the terminator.
 *
 * @param {string} buf
 * @returns {{ idx: number, len: number } | -1}
 */
function findSseSeparator(buf) {
  const a = buf.indexOf('\n\n')
  const b = buf.indexOf('\r\n\r\n')
  if (a === -1 && b === -1) return -1
  if (a === -1) return { idx: b, len: 4 }
  if (b === -1) return { idx: a, len: 2 }
  if (a < b) return { idx: a, len: 2 }
  return { idx: b, len: 4 }
}

/**
 * Parse one SSE event block per the WHATWG eventsource grammar — fields are
 * `field: value` lines, multiple `data:` lines concatenate with `\n`, the
 * default event type is `message`, and lines starting with `:` are comments.
 *
 * @param {string} block
 * @returns {{ event: string, data: string } | null}
 */
function parseSseBlock(block) {
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
      hasField = true
    }
  }
  if (!hasField) return null
  return { event, data }
}
