export type Signal = 'logs' | 'traces' | 'metrics'

export interface StorageConnector {
  /** Scheme this connector handles, e.g. "s3". */
  readonly scheme: string
  /** PUT a single object. Idempotent — overwriting is fine. */
  putObject(key: string, body: Uint8Array, contentType?: string): Promise<void>
  /** HEAD an object to check existence. Returns null if absent. */
  headObject(key: string): Promise<{ size: number } | null>
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
}

export interface ResolvedUploadOptions {
  bucket: string
  prefix: string
  time: string
  signals: ReadonlyArray<Signal>
  catchupDays: number
  region: string
  endpoint?: string
}

export interface LedgerEntry {
  service: string
  signal: Signal
  date: string
  status: 'committed'
  key: string
  size: number
  rows: number
  committedAt: string
}

export interface UploadJob {
  service: string
  signal: Signal
  date: string
  jsonlPath: string
}
