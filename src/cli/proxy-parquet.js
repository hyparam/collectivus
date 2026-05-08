/**
 * Parquet schema + row coercion for `proxy.jsonl`. Two row kinds live in the
 * same file (`exchange` and `stream_event`); we materialize each as its own
 * parquet file with a typed schema. Top-level scalars are typed; open-ended
 * bags (headers, bodies, client info) are JSON columns.
 */

/**
 * @import { ColumnSpec } from '../upload/upload.d.ts'
 */

/** @type {ReadonlyArray<ColumnSpec>} */
const EXCHANGE_COLUMNS = [
  { name: 'exchangeId', type: 'STRING', nullable: false },
  { name: 'tsStart', type: 'TIMESTAMP', nullable: true },
  { name: 'tsEnd', type: 'TIMESTAMP', nullable: true },
  { name: 'durationMs', type: 'DOUBLE', nullable: true },
  { name: 'upstream', type: 'STRING', nullable: true },
  { name: 'clientIp', type: 'STRING', nullable: true },
  { name: 'clientUserAgent', type: 'STRING', nullable: true },
  { name: 'requestMethod', type: 'STRING', nullable: true },
  { name: 'requestPath', type: 'STRING', nullable: true },
  { name: 'requestHeaders', type: 'JSON', nullable: true },
  { name: 'requestBody', type: 'STRING', nullable: true },
  { name: 'responseStatus', type: 'INT32', nullable: true },
  { name: 'responseHeaders', type: 'JSON', nullable: true },
  { name: 'responseBody', type: 'STRING', nullable: true },
  { name: 'streamEventCount', type: 'INT32', nullable: true },
  { name: 'error', type: 'STRING', nullable: true },
]

/** @type {ReadonlyArray<ColumnSpec>} */
const STREAM_EVENT_COLUMNS = [
  { name: 'exchangeId', type: 'STRING', nullable: false },
  { name: 'tMs', type: 'INT32', nullable: true },
  { name: 'event', type: 'STRING', nullable: true },
  { name: 'data', type: 'STRING', nullable: true },
]

/**
 * Pull a value out of a flat row by spec name. Handles the dotted column
 * names that flatten `client.*`, `request.*`, `response.*` into top-level
 * columns.
 *
 * @param {string} name
 * @param {Record<string, unknown>} row
 * @returns {unknown}
 */
function extractExchangeCell(name, row) {
  switch (name) {
  case 'exchangeId': return row.exchange_id
  case 'tsStart': return row.ts_start
  case 'tsEnd': return row.ts_end
  case 'durationMs': return row.duration_ms
  case 'upstream': return row.upstream
  case 'clientIp': return readPath(row, ['client', 'ip'])
  case 'clientUserAgent': return readPath(row, ['client', 'user_agent'])
  case 'requestMethod': return readPath(row, ['request', 'method'])
  case 'requestPath': return readPath(row, ['request', 'path'])
  case 'requestHeaders': return readPath(row, ['request', 'headers'])
  case 'requestBody': return readPath(row, ['request', 'body'])
  case 'responseStatus': return readPath(row, ['response', 'status'])
  case 'responseHeaders': return readPath(row, ['response', 'headers'])
  case 'responseBody': return readPath(row, ['response', 'body'])
  case 'streamEventCount': return row.stream_event_count
  case 'error': return row.error
  default: return row[name]
  }
}

/**
 * @param {string} name
 * @param {Record<string, unknown>} row
 * @returns {unknown}
 */
function extractStreamEventCell(name, row) {
  switch (name) {
  case 'exchangeId': return row.exchange_id
  case 'tMs': return row.t_ms
  case 'event': return row.event
  case 'data': return row.data
  default: return row[name]
  }
}

/**
 * Convert a list of proxy rows of one kind into a parquet buffer.
 * Returns undefined when the input is empty so callers can skip writing.
 *
 * @param {'exchange' | 'stream_event'} kind
 * @param {ReadonlyArray<Record<string, unknown>>} rows
 * @returns {Promise<Uint8Array | undefined>}
 */
export async function proxyRowsToParquet(kind, rows) {
  if (rows.length === 0) return undefined
  const { parquetWriteBuffer } = await import('hyparquet-writer')
  const columns = kind === 'exchange' ? EXCHANGE_COLUMNS : STREAM_EVENT_COLUMNS
  const extract = kind === 'exchange' ? extractExchangeCell : extractStreamEventCell
  const columnData = columns.map((spec) => ({
    name: spec.name,
    type: spec.type,
    nullable: spec.nullable,
    data: rows.map((row) => coerceCell(spec, extract(spec.name, row))),
  }))
  const arrayBuffer = parquetWriteBuffer({ columnData })
  return new Uint8Array(arrayBuffer)
}

/**
 * @param {Record<string, unknown>} row
 * @param {string[]} keys
 * @returns {unknown}
 */
function readPath(row, keys) {
  /** @type {unknown} */
  let cur = row
  for (const key of keys) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = Reflect.get(cur, key)
  }
  return cur
}

/**
 * @param {ColumnSpec} spec
 * @param {unknown} value
 * @returns {unknown}
 */
function coerceCell(spec, value) {
  if (value === undefined || value === null) {
    if (!spec.nullable) {
      throw new Error(`required column "${spec.name}" got null`)
    }
    return undefined
  }
  switch (spec.type) {
  case 'STRING':
    return typeof value === 'string' ? value : JSON.stringify(value)
  case 'INT32':
    return coerceInt32(value, spec.name)
  case 'INT64':
    return coerceInt64(value, spec.name)
  case 'DOUBLE':
    return coerceDouble(value, spec.name)
  case 'BOOLEAN':
    return Boolean(value)
  case 'TIMESTAMP':
    return coerceTimestamp(value, spec.name)
  case 'JSON':
    return value
  default:
    return value
  }
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function coerceInt32(value, name) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const n = Number(value)
    if (Number.isFinite(n)) return Math.trunc(n)
  }
  throw new Error(`column "${name}" expected INT32, got ${typeof value}`)
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {bigint}
 */
function coerceInt64(value, name) {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value))
  if (typeof value === 'string') {
    try { return BigInt(value) } catch { /* fall through */ }
  }
  throw new Error(`column "${name}" expected INT64, got ${typeof value}`)
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function coerceDouble(value, name) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  throw new Error(`column "${name}" expected DOUBLE, got ${typeof value}`)
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {Date}
 */
function coerceTimestamp(value, name) {
  if (value instanceof Date) return value
  if (typeof value === 'string') {
    const d = new Date(value)
    if (!Number.isNaN(d.getTime())) return d
  }
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value)
  if (typeof value === 'bigint') return new Date(Number(value))
  throw new Error(`column "${name}" expected TIMESTAMP, got ${typeof value}`)
}
