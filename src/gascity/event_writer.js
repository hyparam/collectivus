import fs from 'node:fs/promises'
import path from 'node:path'

import { GASCITY_GATEWAY_ID } from './schema.js'
import { eventJsonlPath } from './paths.js'

/**
 * @typedef {import('./types.d.ts').GascityEventRow} GascityEventRow
 * @typedef {import('./types.d.ts').GascityEventScope} GascityEventScope
 */

/**
 * JSONL writer for gascity event bus rows.
 */
export class GascityEventWriter {
  /**
   * @param {{ root: string, stderr?: { write: (s: string) => void } }} opts
   */
  constructor(opts) {
    this.root = opts.root
    /** @type {{ write: (s: string) => void }} */
    this.stderr = opts.stderr ?? process.stderr
    this.queue = Promise.resolve()
    /** @type {Set<string>} */
    this.seenKeys = new Set()
  }

  /**
   * @param {GascityEventRow | undefined} row
   * @returns {Promise<void>}
   */
  append(row) {
    if (!row) return this.queue
    const key = eventRowKey(row)
    if (key && this.seenKeys.has(key)) return this.queue
    if (key) this.seenKeys.add(key)
    this.queue = this.queue
      .then(() => this.writeRow(row))
      .catch((err) => {
        if (key) this.seenKeys.delete(key)
        this.stderr.write(`gascity: failed to write event row: ${formatError(err)}\n`)
      })
    return this.queue
  }

  /**
   * @param {ReadonlyArray<GascityEventRow | undefined>} rows
   * @returns {Promise<void>}
   */
  appendMany(rows) {
    for (const row of rows) {
      this.append(row)
    }
    return this.queue
  }

  /**
   * @returns {Promise<void>}
   */
  async stop() {
    await this.queue
  }

  /**
   * @param {GascityEventRow} row
   * @returns {Promise<void>}
   * @private
   */
  async writeRow(row) {
    const filePath = eventJsonlPath(this.root, row.date, row.event_scope, row.city)
    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.appendFile(filePath, `${JSON.stringify(row)}\n`)
  }
}

/**
 * @param {{
 *   raw: unknown,
 *   eventScope: GascityEventScope,
 *   supervisorUrl: string,
 *   city?: string,
 *   eventId?: string,
 *   eventName?: string,
 *   now?: () => Date,
 * }} opts
 * @returns {GascityEventRow | undefined}
 */
export function normalizeGascityEvent(opts) {
  const raw = opts.raw
  if (raw === undefined || raw === null) return undefined
  /** @type {Record<string, unknown>} */
  const record = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? /** @type {Record<string, unknown>} */ (raw)
    : { payload: raw }
  const ts = stringOrNull(record.ts)
  const date = dateFromTimestamp(ts, opts.now)
  const payload = Object.hasOwn(record, 'payload') ? record.payload : undefined
  return {
    gateway_id: GASCITY_GATEWAY_ID,
    date,
    event_scope: opts.eventScope,
    city: opts.city ?? stringOrNull(record.city),
    supervisor_url: opts.supervisorUrl,
    seq: numberOrNull(record.seq),
    event_id: opts.eventId ?? stringOrNull(record.id),
    type: stringOrNull(record.type) ?? opts.eventName ?? null,
    ts,
    actor: stringOrNull(record.actor),
    subject: stringOrNull(record.subject),
    message: stringOrNull(record.message),
    payload,
    raw_event: raw,
  }
}

/**
 * @param {GascityEventRow} row
 * @returns {number | undefined}
 */
export function eventRowSeq(row) {
  return typeof row.seq === 'number' && Number.isFinite(row.seq) ? row.seq : undefined
}

/**
 * @param {GascityEventRow} row
 * @returns {string | undefined}
 */
function eventRowKey(row) {
  const city = row.city ?? ''
  if (typeof row.seq === 'number' && Number.isFinite(row.seq)) {
    return `${row.event_scope}:${city}:seq:${row.seq}`
  }
  if (row.event_id) {
    return `${row.event_scope}:${city}:id:${row.event_id}`
  }
  return undefined
}

/**
 * @param {string | null} ts
 * @param {(() => Date) | undefined} now
 * @returns {string}
 */
function dateFromTimestamp(ts, now) {
  if (ts) {
    const parsed = new Date(ts)
    if (Number.isFinite(parsed.valueOf())) return parsed.toISOString().slice(0, 10)
  }
  return (now?.() ?? new Date()).toISOString().slice(0, 10)
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function stringOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function numberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const n = Number(value)
    if (Number.isFinite(n)) return Math.trunc(n)
  }
  return null
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}
