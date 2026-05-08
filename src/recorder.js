import { randomBytes } from 'node:crypto'
import { SseParser, isSseHeaders } from './sse.js'

/** @typedef {import('./sinks/file.js').Sink} Sink */

export { isSseHeaders }

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
    /** @type {SseParser} */
    this.sseParser = new SseParser()
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
    const events = this.sseParser.feed(chunk)
    /** @type {Promise<void>[]} */
    const writes = []
    for (const ev of events) {
      this.streamEventCount += 1
      writes.push(this.recorder.sink.writeRow({
        exchange_id: this.id,
        kind: 'stream_event',
        t_ms: Date.now() - this.tsStartMs,
        event: ev.event,
        data: ev.data,
      }))
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

