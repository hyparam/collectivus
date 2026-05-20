import { readCursor, writeCursor } from './cursor.js'
import { eventRowSeq, normalizeGascityEvent } from './event_writer.js'
import { cityEventCursorPath, supervisorEventCursorPath } from './paths.js'
import { streamSse } from './sse_client.js'

/**
 * @import { GascityEventWriter } from './event_writer.js'
 * @import { EventCursor } from './types.d.ts'
 */

const EVENT_SNAPSHOT_TIMEOUT_MS = 30000

/**
 * Supervisor-scope event bus subscriber.
 */
export class SupervisorEventSubscriber {
  /**
   * @param {{
   *   apiUrl: string,
   *   eventSinkRoot: string,
   *   writer: GascityEventWriter,
   *   stderr?: { write: (s: string) => void },
   *   debug?: boolean,
   *   fetchFn?: typeof fetch,
   *   sleep?: (ms: number, signal: AbortSignal) => Promise<void>,
   * }} opts
   */
  constructor(opts) {
    this.apiUrl = opts.apiUrl.replace(/\/+$/, '')
    this.eventSinkRoot = opts.eventSinkRoot
    this.writer = opts.writer
    this.stderr = opts.stderr ?? process.stderr
    this.debug = opts.debug ?? false
    this.fetchFn = opts.fetchFn
    this.sleep = opts.sleep
    this.controller = new AbortController()
    /** @type {Promise<void> | undefined} */
    this.runPromise = undefined
  }

  /**
   * @returns {Promise<void>}
   */
  start() {
    if (this.runPromise) return this.runPromise
    this.runPromise = this.run().catch((err) => {
      this.stderr.write(`[gascity] supervisor_events_crashed api_url=${this.apiUrl} err=${formatError(err)}\n`)
    })
    return this.runPromise
  }

  /**
   * @returns {Promise<void>}
   */
  async stop() {
    this.controller.abort()
    if (this.runPromise) await this.runPromise
  }

  /**
   * @returns {Promise<void>}
   * @private
   */
  async run() {
    const cursorPath = supervisorEventCursorPath(this.eventSinkRoot, this.apiUrl)
    const cursor = await readEventCursor(cursorPath, this.stderr)
    this.scheduleSupervisorBackfill(cursorPath, cursor)
    const url = `${this.apiUrl}/v0/events/stream`
    if (this.debug) {
      this.stderr.write(`[gascity] supervisor_events_start url=${url}\n`)
    }
    /** @type {Parameters<typeof streamSse>[0]} */
    const streamOpts = {
      url,
      signal: this.controller.signal,
      onEvent: async (ev) => this.handleEvent(ev, cursorPath),
      onError: (msg) => this.stderr.write(`${msg}\n`),
      onConnect: () => {
        if (this.debug) {
          this.stderr.write(`[gascity] supervisor_events_connected api_url=${this.apiUrl}\n`)
        }
      },
      initialLastEventId: cursor.last_event_id ?? seqToEventId(cursor.last_seq),
    }
    if (this.fetchFn) streamOpts.fetchFn = this.fetchFn
    if (this.sleep) streamOpts.sleep = this.sleep
    await streamSse(streamOpts)
    if (this.debug) {
      this.stderr.write(`[gascity] supervisor_events_stop api_url=${this.apiUrl}\n`)
    }
  }

  /**
   * @param {string} cursorPath
   * @param {EventCursor} cursor
   * @returns {void}
   * @private
   */
  scheduleSupervisorBackfill(cursorPath, cursor) {
    backfillEventSnapshot({
      apiUrl: this.apiUrl,
      eventSinkRoot: this.eventSinkRoot,
      writer: this.writer,
      cursorPath,
      cursor,
      fetchFn: this.fetchFn ?? globalThis.fetch,
      signal: this.controller.signal,
      stderr: this.stderr,
      debug: this.debug,
    }).catch((err) => {
      if (this.controller.signal.aborted) return
      this.stderr.write(`[gascity] supervisor_events_backfill_failed api_url=${this.apiUrl} err=${formatError(err)}\n`)
    })
  }

  /**
   * @param {import('../types.js').SseEvent} ev
   * @param {string} cursorPath
   * @returns {Promise<void>}
   * @private
   */
  async handleEvent(ev, cursorPath) {
    if (ev.event === 'ping' || ev.event === 'heartbeat') return
    /** @type {unknown} */
    let payload = {}
    if (ev.data.length > 0) {
      try {
        payload = JSON.parse(ev.data)
      } catch (err) {
        this.stderr.write(`[gascity] supervisor_events_parse_error api_url=${this.apiUrl} err=${formatError(err)}\n`)
        return
      }
    }
    const row = normalizeGascityEvent({
      raw: payload,
      eventScope: 'supervisor',
      supervisorUrl: this.apiUrl,
      eventId: ev.id,
      eventName: ev.event,
    })
    await this.writer.append(row)
    await writeEventCursor(cursorPath, ev.id, row, this.stderr)
  }
}

/**
 * Backfill the snapshot endpoint once. The server currently returns `{items}`
 * and may ignore `after`, so cursor filtering is applied client-side too.
 *
 * @param {{
 *   apiUrl: string,
 *   eventSinkRoot: string,
 *   writer: GascityEventWriter,
 *   cursorPath: string,
 *   cursor?: EventCursor,
 *   city?: string,
 *   fetchFn: typeof fetch,
 *   signal: AbortSignal,
 *   stderr: { write: (s: string) => void },
 *   debug?: boolean,
 * }} opts
 * @returns {Promise<number>}
 */
export async function backfillEventSnapshot(opts) {
  const apiUrl = opts.apiUrl.replace(/\/+$/, '')
  const lastSeq = opts.cursor?.last_seq
  const endpoint = opts.city === undefined
    ? `${apiUrl}/v0/events`
    : `${apiUrl}/v0/city/${encodeURIComponent(opts.city)}/events`
  const url = lastSeq === undefined ? endpoint : `${endpoint}?after=${encodeURIComponent(String(lastSeq))}`
  if (opts.debug) {
    const scope = opts.city === undefined ? 'supervisor' : `city=${opts.city}`
    opts.stderr.write(`[gascity] events_backfill_start scope=${scope} url=${url}\n`)
  }
  const response = await fetchWithTimeout(opts.fetchFn, url, opts.signal, EVENT_SNAPSHOT_TIMEOUT_MS)
  if (!response.ok) {
    await drainBody(response)
    throw new Error(`HTTP ${response.status}`)
  }
  /** @type {unknown} */
  const body = await response.json()
  const items = parseEventItems(body)
  let accepted = 0
  let maxSeq = lastSeq
  for (const item of items) {
    if (opts.signal.aborted) return accepted
    const row = normalizeGascityEvent({
      raw: item,
      eventScope: opts.city === undefined ? 'supervisor' : 'city',
      supervisorUrl: apiUrl,
      city: opts.city,
    })
    const seq = row === undefined ? undefined : eventRowSeq(row)
    if (seq !== undefined && lastSeq !== undefined && seq <= lastSeq) continue
    await opts.writer.append(row)
    accepted += 1
    if (seq !== undefined && (maxSeq === undefined || seq > maxSeq)) maxSeq = seq
  }
  await writeEventCursorState(opts.cursorPath, undefined, maxSeq, opts.stderr)
  if (opts.debug) {
    const scope = opts.city === undefined ? 'supervisor' : `city=${opts.city}`
    opts.stderr.write(`[gascity] events_backfill_complete scope=${scope} events=${accepted}\n`)
  }
  return accepted
}

/**
 * @param {string} eventSinkRoot
 * @param {string} city
 * @returns {string}
 */
export function cityEventsCursorPath(eventSinkRoot, city) {
  return cityEventCursorPath(eventSinkRoot, city)
}

/**
 * @param {string} filePath
 * @param {{ write: (s: string) => void }} stderr
 * @returns {Promise<EventCursor>}
 */
export async function readEventCursor(filePath, stderr) {
  const cursor = await readCursor(filePath, { onError: (m) => stderr.write(`${m}\n`) })
  /** @type {EventCursor} */
  const out = {}
  if (typeof cursor?.last_event_id === 'string') out.last_event_id = cursor.last_event_id
  if (typeof cursor?.last_seq === 'number' && Number.isFinite(cursor.last_seq)) out.last_seq = cursor.last_seq
  return out
}

/**
 * @param {string} cursorPath
 * @param {string | undefined} eventId
 * @param {import('./types.d.ts').GascityEventRow | undefined} row
 * @param {{ write: (s: string) => void }} stderr
 * @returns {Promise<void>}
 */
export async function writeEventCursor(cursorPath, eventId, row, stderr) {
  if (eventId === undefined && row === undefined) return
  const seq = row === undefined ? undefined : eventRowSeq(row)
  await writeEventCursorState(cursorPath, eventId, seq, stderr)
}

/**
 * @param {string} cursorPath
 * @param {string | undefined} eventId
 * @param {number | undefined} seq
 * @param {{ write: (s: string) => void }} stderr
 * @returns {Promise<void>}
 */
async function writeEventCursorState(cursorPath, eventId, seq, stderr) {
  if (eventId === undefined && seq === undefined) return
  try {
    const current = await readEventCursor(cursorPath, stderr)
    const currentSeq = current.last_seq
    const nextSeq = seq !== undefined && (currentSeq === undefined || seq > currentSeq) ? seq : currentSeq
    const nextEventId = shouldReplaceEventId(currentSeq, seq, eventId)
      ? eventId
      : current.last_event_id
    await writeCursor(cursorPath, {
      ...(nextEventId !== undefined ? { last_event_id: nextEventId } : {}),
      ...(nextSeq !== undefined ? { last_seq: nextSeq } : {}),
    })
  } catch (err) {
    stderr.write(`[gascity] events_cursor_write_failed cursor=${cursorPath} err=${formatError(err)}\n`)
  }
}

/**
 * @param {number | undefined} currentSeq
 * @param {number | undefined} nextSeq
 * @param {string | undefined} nextEventId
 * @returns {boolean}
 */
function shouldReplaceEventId(currentSeq, nextSeq, nextEventId) {
  if (nextEventId === undefined) return false
  if (nextSeq === undefined || currentSeq === undefined) return true
  return nextSeq >= currentSeq
}

/**
 * @param {unknown} body
 * @returns {unknown[]}
 */
function parseEventItems(body) {
  if (Array.isArray(body)) return body
  if (body === null || typeof body !== 'object') return []
  const items = /** @type {Record<string, unknown>} */ (body).items
  return Array.isArray(items) ? items : []
}

/**
 * @param {number | undefined} seq
 * @returns {string | undefined}
 */
function seqToEventId(seq) {
  return seq === undefined ? undefined : String(seq)
}

/**
 * @param {typeof fetch} fetchFn
 * @param {string} url
 * @param {AbortSignal} parentSignal
 * @param {number} timeoutMs
 * @returns {Promise<Response>}
 */
async function fetchWithTimeout(fetchFn, url, parentSignal, timeoutMs) {
  if (parentSignal.aborted) throw new Error('aborted')
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  function onAbort() {
    controller.abort()
  }
  parentSignal.addEventListener('abort', onAbort, { once: true })
  try {
    return await fetchFn(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timeout)
    parentSignal.removeEventListener('abort', onAbort)
  }
}

/**
 * @param {Response} response
 * @returns {Promise<void>}
 */
async function drainBody(response) {
  if (!response.body) return
  try {
    const reader = response.body.getReader()
    while (true) {
      const { done } = await reader.read()
      if (done) return
    }
  } catch {
    // Best effort; the server may have already closed the body.
  }
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}
