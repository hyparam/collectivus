import type { ColumnSpec, Signal } from '../upload/upload.js'
import type { CollectivusConfig } from '../types.js'

export type QueryDataset =
  | 'logs'
  | 'traces'
  | 'metrics'
  | 'proxy_exchanges'
  | 'proxy_stream_events'

export type QueryFormat = 'table' | 'json' | 'jsonl' | 'markdown'
export type QueryRefreshMode = 'never' | 'always'

export interface QueryScope {
  dataset?: QueryDataset
  datasets?: QueryDataset[]
  gatewayId?: string
  date?: string
  from?: string
  to?: string
  service?: string
  limit: number
}

export interface QueryPaths {
  config: CollectivusConfig
  configPath: string
  recordingRoot: string
  parquetDir?: string
  parquetEnabled: boolean
  explicitParquetDir: boolean
}

export interface SourceFile {
  gatewayId: string
  signal: Signal | 'proxy'
  date: string
  jsonlPath: string
  size: number
  mtimeMs: number
}

export interface CachePartition {
  dataset: QueryDataset
  gatewayId: string
  date: string
  /**
   * Where the source JSONL was, or still is, on disk. For sealed
   * (drained) partitions synthesized from a CacheMeta, this is the path
   * the meta recorded at last refresh — the file itself may no longer
   * exist.
   */
  jsonlPath: string
  /** Source size at last refresh. Meaningless once the source is drained. */
  sourceSize: number
  /** Source mtime at last refresh. Meaningless once the source is drained. */
  sourceMtimeMs: number
  parquetPath: string
  metaPath: string
}

export interface CacheMeta {
  cache_schema_version: number
  dataset: QueryDataset
  gateway_id: string
  date: string
  source_path: string
  source_size: number
  source_mtime_ms: number
  row_count: number
  refreshed_at: string
}

export type CachePartitionStatus = 'fresh' | 'missing' | 'stale'

export interface CachePartitionState {
  partition: CachePartition
  status: CachePartitionStatus
  meta?: CacheMeta
  reason?: string
}

export interface DatasetSchema {
  dataset: QueryDataset
  sourceSignal: Signal | 'proxy'
  columns: readonly ColumnSpec[]
}

export interface RefreshResult {
  written: number
  skipped: number
  rows: number
  failures: number
  files: RefreshFileResult[]
}

export interface RefreshFileResult {
  dataset: QueryDataset
  gatewayId: string
  date: string
  rows: number
  parquetPath: string
  status: 'written' | 'skipped' | 'failed'
  error?: string
}

export interface QueryResultSet {
  columns: string[]
  rows: Record<string, unknown>[]
}
