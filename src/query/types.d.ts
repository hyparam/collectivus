import type { ColumnSpec, Signal } from '../upload/upload.js'
import type { CollectivusConfig } from '../types.js'

export type QueryDataset =
  | 'logs'
  | 'traces'
  | 'metrics'
  | 'proxy_messages'
  | 'gascity_messages'

export type QueryFormat = 'table' | 'json' | 'jsonl' | 'markdown'
export type QueryRefreshMode = 'never' | 'always'

export interface QueryScope {
  dataset?: string
  datasets?: string[]
  /** Absolute source JSONL paths to include when refreshing or inspecting a narrow cache scope. */
  sourcePaths?: string[]
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
  /**
   * Signal of the on-disk JSONL file. Gascity is intentionally absent —
   * gascity skips the JSONL stage entirely and `discoverSourceFiles` never
   * yields a `SourceFile` for it; query-time discovery for `gascity_messages`
   * goes through {@link CachePartition} directly via `discoverGascityPartitions`.
   */
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
  sourceSignal: Signal | 'proxy' | 'gascity'
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
  dataset: string
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

export interface JsonlCollection {
  /** Original user-facing name passed to `ctvs collect --name`. */
  name: string
  /** SQL-safe table name exposed to `ctvs query sql`. */
  table: string
  /**
   * Absolute path to a single external JSONL source file. Exactly one of
   * `source_path` or `source_glob` is set on a valid collection.
   */
  source_path?: string
  /**
   * Absolute glob pattern matching one or more external JSONL source files.
   * Each matched file becomes its own cache partition under
   * `collections/<table>/source=<hash>/data.parquet`.
   */
  source_glob?: string
  /** Optional source field requested for time filtering. */
  timestamp_column?: string
  created_at: string
  updated_at: string
}

export interface CollectionsManifest {
  version: 2
  collections: Record<string, JsonlCollection>
}

export interface CollectionColumnMeta {
  name: string
  source_field?: string
  type: ColumnSpec['type']
  nullable: boolean
}

export interface CollectionCacheMeta {
  cache_schema_version: number
  kind: 'collection'
  table: string
  name: string
  source_path: string
  source_size: number
  source_mtime_ms: number
  row_count: number
  refreshed_at: string
  columns: CollectionColumnMeta[]
  timestamp_column?: string
}

export interface CollectionCachePartition {
  kind: 'collection'
  dataset: string
  table: string
  collection: JsonlCollection
  jsonlPath: string
  sourceExists: boolean
  sourceSize: number
  sourceMtimeMs: number
  parquetPath: string
  metaPath: string
}
