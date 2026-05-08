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
