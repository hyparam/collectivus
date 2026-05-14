import { readCursor, writeCursor } from './cursor.js'
import { sessionCursorPath } from './paths.js'
import { streamSse } from './sse_client.js'

/**
 * @import { SessionContext } from './types.d.ts'
 * @import { NormalizerDispatcher } from './normalizer_dispatcher.js'
 */

/**
 * Per-session frame consumer. Owns one SSE connection to
 * `/v0/city/{city}/session/{id}/stream?format=raw`, parses each `data:`
 * payload as the supervisor's `format=raw` envelope, and hands it to the
 * normalizer dispatcher. Reconnect / cursor persistence are delegated to
 * `streamSse` and `cursor.js` respectively so this class stays small.
 */
export class SessionWorker {
  /**
   * @param {{
   *   city: string,
   *   apiUrl: string,
   *   sessionId: string,
   *   template?: string,
   *   rig?: string,
   *   alias?: string,
   *   sinkRoot: string,
   *   dispatcher: NormalizerDispatcher,
   *   stderr?: { write: (s: string) => void },
   *   debug?: boolean,
   *   fetchFn?: typeof fetch,
   *   sleep?: (ms: number, signal: AbortSignal) => Promise<void>,
   * }} opts
   */
  constructor(opts) {
    /** @type {string} */
    this.city = opts.city
    /** @type {string} */
    this.apiUrl = opts.apiUrl.replace(/\/+$/, '')
    /** @type {string} */
    this.sessionId = opts.sessionId
    /** @type {string | undefined} */
    this.template = opts.template
    /** @type {string | undefined} */
    this.rig = opts.rig
    /** @type {string | undefined} */
    this.alias = opts.alias
    /** @type {string} */
    this.sinkRoot = opts.sinkRoot
    /** @type {NormalizerDispatcher} */
    this.dispatcher = opts.dispatcher
    /** @type {{ write: (s: string) => void }} */
    this.stderr = opts.stderr ?? process.stderr
    /** @type {boolean} */
    this.debug = opts.debug ?? false
    /** @type {typeof fetch | undefined} */
    this.fetchFn = opts.fetchFn
    /** @type {((ms: number, signal: AbortSignal) => Promise<void>) | undefined} */
    this.sleep = opts.sleep
    /** @type {AbortController} */
    this.controller = new AbortController()
    /** @type {Promise<void> | undefined} */
    this.runPromise = undefined
    /** @type {string | undefined} Last frame uuid we successfully dispatched. */
    this.lastUuid = undefined
    /** @type {boolean} */
    this.draining = false
  }

  /**
   * Open the per-session SSE connection and start dispatching frames. Idempotent
   * — subsequent calls return the in-flight promise.
   *
   * @returns {Promise<void>}
   */
  start() {
    if (this.runPromise) return this.runPromise
    this.runPromise = this.run().catch((err) => {
      this.stderr.write(`[gascity] session worker crashed city=${this.city} session=${this.sessionId} err=${formatError(err)}\n`)
    })
    return this.runPromise
  }

  /**
   * Mark the worker as draining (no more frames expected) and wait for the
   * SSE loop to exit. Called by the supervisor on `session.draining` /
   * `session.stopped` lifecycle events. The cursor file is left intact so a
   * subsequent restart can resume from `last_uuid`.
   *
   * @returns {Promise<void>}
   */
  async stop() {
    this.draining = true
    this.controller.abort()
    if (this.runPromise) await this.runPromise
  }

  /**
   * @returns {Promise<void>}
   * @private
   */
  async run() {
    const cursorPath = sessionCursorPath(this.sinkRoot, this.city, this.sessionId)
    const cursor = await readCursor(cursorPath, { onError: (m) => this.stderr.write(`${m}\n`) })
    const initialAfter = typeof cursor?.last_uuid === 'string' ? cursor.last_uuid : undefined
    if (initialAfter !== undefined) {
      this.lastUuid = initialAfter
    }
    const url = buildSessionStreamUrl(this.apiUrl, this.city, this.sessionId, initialAfter)
    if (this.debug) {
      this.stderr.write(`[gascity] session_worker_start city=${this.city} session=${this.sessionId} url=${url}\n`)
    }
    /** @type {SessionContext} */
    const ctx = {
      city: this.city,
      sessionId: this.sessionId,
      template: this.template,
      rig: this.rig,
      alias: this.alias,
    }
    /** @type {Parameters<typeof streamSse>[0]} */
    const streamOpts = {
      url,
      signal: this.controller.signal,
      onEvent: async (ev) => this.handleEvent(ev, cursorPath, ctx),
      onError: (msg) => this.stderr.write(`${msg}\n`),
      onConnect: () => {
        if (this.debug) {
          this.stderr.write(`[gascity] session_worker_connected city=${this.city} session=${this.sessionId}\n`)
        }
      },
      initialLastEventId: initialAfter,
    }
    if (this.fetchFn) streamOpts.fetchFn = this.fetchFn
    if (this.sleep) streamOpts.sleep = this.sleep
    await streamSse(streamOpts)
    if (this.debug) {
      this.stderr.write(`[gascity] session_worker_stop city=${this.city} session=${this.sessionId}\n`)
    }
  }

  /**
   * Parse one SSE event as a supervisor frame envelope and route to the
   * dispatcher. Updates the in-memory `lastUuid` and persists the cursor on
   * every successfully-parsed frame so a crash mid-session loses at most one
   * already-dispatched frame.
   *
   * @param {import('../types.js').SseEvent} ev
   * @param {string} cursorPath
   * @param {SessionContext} ctx
   * @returns {Promise<void>}
   * @private
   */
  async handleEvent(ev, cursorPath, ctx) {
    if (ev.event === 'ping' || ev.event === 'heartbeat') return
    if (ev.data.length === 0) return
    /** @type {unknown} */
    let envelope
    try {
      envelope = JSON.parse(ev.data)
    } catch (err) {
      this.stderr.write(
        `[gascity] frame_parse_error city=${this.city} session=${this.sessionId} err=${formatError(err)}\n`
      )
      return
    }
    if (this.debug) {
      this.stderr.write(`[gascity] frame_received city=${this.city} session=${this.sessionId} event=${ev.event}\n`)
    }
    this.dispatcher.dispatch(envelope, ctx)
    const uuid = extractUuid(envelope)
    if (uuid !== undefined && uuid !== this.lastUuid) {
      this.lastUuid = uuid
      try {
        await writeCursor(cursorPath, { last_uuid: uuid })
      } catch (err) {
        this.stderr.write(
          `[gascity] cursor_write_failed city=${this.city} session=${this.sessionId} err=${formatError(err)}\n`
        )
      }
    }
  }
}

/**
 * Build the SSE URL for a session's frame stream. When `after` is provided
 * we append `?after=<uuid>` so the supervisor resumes from the next frame
 * — `Last-Event-ID` is also sent (by `streamSse`) but the supervisor's REST
 * docs document the `after` query param explicitly, so we use both for
 * resilience against a server that may have only implemented one.
 *
 * @param {string} apiUrl
 * @param {string} city
 * @param {string} sessionId
 * @param {string | undefined} after
 * @returns {string}
 */
export function buildSessionStreamUrl(apiUrl, city, sessionId, after) {
  const base = `${apiUrl}/v0/city/${encodeURIComponent(city)}/session/${encodeURIComponent(sessionId)}/stream`
  const params = new URLSearchParams({ format: 'raw' })
  if (after !== undefined) params.set('after', after)
  return `${base}?${params.toString()}`
}

/**
 * Pull the per-frame uuid off a supervisor frame envelope. Different providers
 * surface the uuid in different positions; we look at the obvious places and
 * return undefined when the envelope doesn't carry one (passthrough provider,
 * malformed frame, etc).
 *
 * @param {unknown} envelope
 * @returns {string | undefined}
 */
export function extractUuid(envelope) {
  if (envelope === null || typeof envelope !== 'object') return undefined
  const obj = /** @type {Record<string, unknown>} */ (envelope)
  if (typeof obj.uuid === 'string') return obj.uuid
  if (obj.frame && typeof obj.frame === 'object') {
    const frame = /** @type {Record<string, unknown>} */ (obj.frame)
    if (typeof frame.uuid === 'string') return frame.uuid
  }
  return undefined
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}
