import { columnsForSignal, extractCell } from '../schema.js'

/**
 * Iceberg schema, partition spec, and record coercion for the Iceberg
 * upload mode.
 *
 * Each (service, signal) maps to one Iceberg table partitioned by date
 * (identity transform on a synthetic `date` column populated from the
 * job's date — every row in a batch shares the same partition value, so
 * a daily job appends exactly one data file per service-signal table).
 *
 * Type mapping (collectivus parquet BasicType → Iceberg type):
 *   STRING    → string
 *   INT32     → int
 *   INT64     → long      (bigint at write time)
 *   DOUBLE    → double
 *   BOOLEAN   → boolean
 *   TIMESTAMP → timestamptz (Date — UTC-adjusted, microsecond)
 *   JSON      → variant   (v3 only; pass-through plain object/array)
 */

/**
 * @import { Schema, PartitionSpec, IcebergType } from 'icebird/src/types.js'
 * @import { Signal, ColumnSpec } from '../upload.d.ts'
 */

const DATE_FIELD_ID = 1
const SERVICE_FIELD_ID = 2
const FIRST_DYNAMIC_FIELD_ID = 3
const PARTITION_FIELD_ID = 1000

/**
 * Build the Iceberg `Schema` for a signal. `date` and `serviceName` are
 * stable required fields (ids 1 and 2). When `partitionDimensions`
 * includes `'gateway_id'`, that column is added as a required string
 * field. Remaining fields come from `columnsForSignal()`.
 *
 * @param {Signal} signal
 * @param {ReadonlyArray<string>} [partitionDimensions]
 * @returns {Schema}
 */
export function icebergSchemaForSignal(signal, partitionDimensions) {
  const cols = columnsForSignal(signal, partitionDimensions)
  const hasGatewayId = Array.isArray(partitionDimensions) && partitionDimensions.includes('gateway_id')
  /** @type {Schema['fields']} */
  const fields = [
    { id: DATE_FIELD_ID, name: 'date', required: true, type: 'date' },
    { id: SERVICE_FIELD_ID, name: 'serviceName', required: true, type: 'string' },
  ]
  let nextId = FIRST_DYNAMIC_FIELD_ID
  if (hasGatewayId) {
    fields.push({ id: nextId++, name: 'gateway_id', required: true, type: 'string' })
  }
  for (const col of cols) {
    if (col.name === 'serviceName' || col.name === 'gateway_id') continue
    fields.push({
      id: nextId++,
      name: col.name,
      required: false,
      type: icebergTypeForBasicType(col.type),
    })
  }
  return { type: 'struct', 'schema-id': 0, fields }
}

/**
 * Build the partition spec for an Iceberg table: identity on `date`.
 *
 * @returns {PartitionSpec}
 */
export function partitionSpecForSignal() {
  return {
    'spec-id': 0,
    fields: [
      {
        'source-id': DATE_FIELD_ID,
        'field-id': PARTITION_FIELD_ID,
        name: 'date',
        transform: 'identity',
      },
    ],
  }
}

/**
 * Coerce normalized JSONL rows into Iceberg records ready for
 * `icebergAppend`. Every row in a batch is tagged with the same `date`
 * partition value derived from the job's date string.
 *
 * @param {Signal} signal
 * @param {ReadonlyArray<Record<string, unknown>>} rows
 * @param {string} date YYYY-MM-DD
 * @param {ReadonlyArray<string>} [partitionDimensions]
 * @returns {Record<string, unknown>[]}
 */
export function rowsToIcebergRecords(signal, rows, date, partitionDimensions) {
  const cols = columnsForSignal(signal, partitionDimensions)
  const partitionDate = new Date(`${date}T00:00:00Z`)
  if (Number.isNaN(partitionDate.getTime())) {
    throw new Error(`invalid partition date: ${date}`)
  }
  return rows.map((row) => {
    /** @type {Record<string, unknown>} */
    const rec = { date: partitionDate }
    for (const col of cols) {
      const cell = extractCell(col.name, row)
      rec[col.name] = coerceForIceberg(col, cell)
    }
    if (rec.serviceName === undefined || rec.serviceName === null) {
      throw new Error('required column "serviceName" got null')
    }
    if (cols.some((c) => c.name === 'gateway_id')
        && (rec.gateway_id === undefined || rec.gateway_id === null)) {
      throw new Error('required column "gateway_id" got null')
    }
    return rec
  })
}

/**
 * @param {ColumnSpec['type']} type
 * @returns {IcebergType}
 */
function icebergTypeForBasicType(type) {
  switch (type) {
  case 'STRING': return 'string'
  case 'INT32': return 'int'
  case 'INT64': return 'long'
  case 'DOUBLE': return 'double'
  case 'BOOLEAN': return 'boolean'
  case 'TIMESTAMP': return 'timestamptz'
  case 'JSON': return 'variant'
  default:
    throw new Error(`unsupported BasicType for iceberg: ${type}`)
  }
}

/**
 * Coerce a raw cell value to the JS shape icebird expects for the
 * column's Iceberg type. Mirrors `coerceCell` in upload/schema.js but
 * targets icebird's record contract instead of hyparquet-writer's
 * column types.
 *
 * @param {ColumnSpec} spec
 * @param {unknown} value
 * @returns {unknown}
 */
function coerceForIceberg(spec, value) {
  if (value === undefined || value === null) {
    return undefined
  }
  switch (spec.type) {
  case 'STRING':
    return typeof value === 'string' ? value : String(value)
  case 'INT32':
    return coerceInt(value, spec.name)
  case 'INT64':
    return coerceLong(value, spec.name)
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
function coerceInt(value, name) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const n = Number(value)
    if (Number.isFinite(n)) return Math.trunc(n)
  }
  throw new Error(`column "${name}" expected int, got ${typeof value}`)
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {bigint}
 */
function coerceLong(value, name) {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value))
  if (typeof value === 'string') {
    try {
      return BigInt(value)
    } catch {
      // fall through
    }
  }
  throw new Error(`column "${name}" expected long, got ${typeof value}`)
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
  throw new Error(`column "${name}" expected double, got ${typeof value}`)
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
  throw new Error(`column "${name}" expected timestamptz, got ${typeof value}`)
}
