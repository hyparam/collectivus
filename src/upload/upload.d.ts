export type Signal = 'logs' | 'traces' | 'metrics'

export interface StorageConnector {
  /** Scheme this connector handles, e.g. "s3". */
  readonly scheme: string
  /** PUT a single object. Idempotent — overwriting is fine. */
  putObject(key: string, body: Uint8Array, contentType?: string): Promise<void>
  /** HEAD an object to check existence. Returns undefined if absent. */
  headObject(key: string): Promise<{ size: number } | undefined>
  close?(): Promise<void>
}

export interface UploadOptions {
  bucket: string
  prefix?: string
  time?: string
  signals?: ReadonlyArray<Signal>
  catchupDays?: number
  region?: string
  endpoint?: string
  /**
   * Names of the directory partition levels under `outputDir`, in order.
   * Default `['service', 'signal']` preserves the legacy standalone layout
   * `<outputDir>/services/<service>/<signal>-<date>.jsonl`. Server-mode
   * (parquet drain over the multi-tenant ingest spool) passes
   * `['gateway_id', 'signal']` to walk
   * `<outputDir>/<gateway_id>/<signal>/<date>.jsonl`.
   */
  partitionDimensions?: ReadonlyArray<string>
}

export interface ResolvedUploadOptions {
  bucket: string
  prefix: string
  time: string
  signals: ReadonlyArray<Signal>
  catchupDays: number
  region: string
  endpoint?: string
  partitionDimensions: ReadonlyArray<string>
}

export interface LedgerEntry {
  /**
   * Partition values for this entry's job, keyed by partition dimension
   * name (e.g. `{service:'svc-a',signal:'logs'}` for standalone, or
   * `{gateway_id:'gw-1',signal:'logs'}` for server). Always includes
   * `signal`; other keys depend on the configured partition dimensions.
   */
  partitions: Readonly<Record<string, string>>
  signal: Signal
  date: string
  status: 'committed'
  key: string
  size: number
  rows: number
  committedAt: string
  /**
   * @deprecated Convenience copy of `partitions.service` retained so
   * ledger lines written before the multi-tenant refactor can still be
   * read. New writes set this only when `partitions.service` exists.
   */
  service?: string
}

export interface UploadJob {
  /**
   * Partition values for this job, keyed by dimension name. Always
   * includes `signal`; other keys depend on the configured partition
   * dimensions (e.g. `service` for standalone, `gateway_id` for server).
   */
  partitions: Readonly<Record<string, string>>
  signal: Signal
  date: string
  jsonlPath: string
  /**
   * @deprecated Convenience copy of `partitions.service` populated by
   * the legacy standalone walker for backward compatibility with code
   * that read `job.service` directly. Absent when `service` is not a
   * configured partition dimension. New code should read
   * `partitions.service`.
   */
  service?: string
}

export interface UploadResult {
  job: UploadJob
  uploaded: boolean
  key: string
  rows: number
  size: number
  error?: Error
  retryable?: boolean
}

export interface UploadDeps {
  /** Max attempts per connector call (HEAD/PUT). Default 3. */
  maxAttempts?: number
  /** Backoff before the second attempt; later attempts back off 4x. Default 1000ms. */
  initialBackoffMs?: number
  /** Sleep override — tests pass `() => Promise.resolve()` to skip the wait. */
  sleep?: (ms: number) => Promise<void>
}

import type { BasicType } from 'hyparquet-writer'

export interface ColumnSpec {
  name: string
  type: BasicType
  nullable: boolean
}

export interface S3ConnectorOptions {
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  /** Override base URL for S3-compatible servers (MinIO, etc.) */
  endpoint?: string
}

export interface S3RequestOptions {
  bucket: string
  region: string
  accessKeyId: string
  secretAccessKey: string
  sessionToken?: string
  endpoint?: string
  method: 'PUT' | 'HEAD' | 'GET'
  key: string
  body?: Uint8Array
  contentType?: string
}
