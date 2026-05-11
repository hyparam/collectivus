import { columnsForSignal } from '../upload/schema.js'
import { columnsForProxyKind } from '../cli/proxy-parquet.js'

/**
 * @import { ColumnSpec } from '../upload/upload.d.ts'
 * @import { QueryDataset, DatasetSchema } from './types.js'
 */

export const QUERY_CACHE_SCHEMA_VERSION = 1

/** @type {readonly QueryDataset[]} */
export const QUERY_DATASETS = [
  'logs',
  'traces',
  'metrics',
  'proxy_exchanges',
  'proxy_stream_events',
]

/** @type {ColumnSpec} */
const DATE_COLUMN = { name: 'date', type: 'STRING', nullable: false }

/**
 * @param {readonly ColumnSpec[]} columns
 * @returns {readonly ColumnSpec[]}
 */
function withDateColumn(columns) {
  return [...columns, DATE_COLUMN]
}

/** @type {Record<QueryDataset, DatasetSchema>} */
const SCHEMAS = {
  logs: {
    dataset: 'logs',
    sourceSignal: 'logs',
    columns: withDateColumn(columnsForSignal('logs', ['gateway_id'])),
  },
  traces: {
    dataset: 'traces',
    sourceSignal: 'traces',
    columns: withDateColumn(columnsForSignal('traces', ['gateway_id'])),
  },
  metrics: {
    dataset: 'metrics',
    sourceSignal: 'metrics',
    columns: withDateColumn(columnsForSignal('metrics', ['gateway_id'])),
  },
  proxy_exchanges: {
    dataset: 'proxy_exchanges',
    sourceSignal: 'proxy',
    columns: withDateColumn(columnsForProxyKind('exchange', ['gateway_id'])),
  },
  proxy_stream_events: {
    dataset: 'proxy_stream_events',
    sourceSignal: 'proxy',
    columns: withDateColumn(columnsForProxyKind('stream_event', ['gateway_id'])),
  },
}

/**
 * @param {unknown} value
 * @returns {value is QueryDataset}
 */
export function isQueryDataset(value) {
  return typeof value === 'string' && QUERY_DATASETS.includes(/** @type {QueryDataset} */ (value))
}

/**
 * @param {string} value
 * @returns {QueryDataset}
 */
export function assertQueryDataset(value) {
  if (isQueryDataset(value)) return value
  throw new Error(`unknown dataset "${value}"`)
}

/**
 * @param {QueryDataset} dataset
 * @returns {DatasetSchema}
 */
export function schemaForDataset(dataset) {
  return SCHEMAS[dataset]
}

/**
 * @param {QueryDataset} dataset
 * @returns {readonly ColumnSpec[]}
 */
export function columnsForDataset(dataset) {
  return SCHEMAS[dataset].columns
}

/**
 * @param {QueryDataset} dataset
 * @returns {'logs' | 'traces' | 'metrics' | 'proxy'}
 */
export function sourceSignalForDataset(dataset) {
  return SCHEMAS[dataset].sourceSignal
}

/**
 * @param {QueryDataset} dataset
 * @returns {string | undefined}
 */
export function primaryTimestampColumn(dataset) {
  switch (dataset) {
  case 'logs': return 'timestamp'
  case 'traces': return 'startTimestamp'
  case 'metrics': return 'timestamp'
  case 'proxy_exchanges': return 'tsStart'
  case 'proxy_stream_events': return undefined
  default: return undefined
  }
}

/**
 * @param {QueryDataset} dataset
 * @returns {string[]}
 */
export function fallbackTimestampColumns(dataset) {
  switch (dataset) {
  case 'logs': return ['timestamp', 'observedTimestamp']
  case 'traces': return ['startTimestamp', 'endTimestamp']
  case 'metrics': return ['timestamp', 'startTimestamp']
  case 'proxy_exchanges': return ['tsStart', 'tsEnd']
  case 'proxy_stream_events': return []
  default: return []
  }
}
