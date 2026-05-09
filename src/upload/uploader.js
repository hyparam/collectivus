import fs from 'node:fs'
import path from 'node:path'
import { appendLedger, isCommittedJob, readLedger } from './ledger.js'
import { rowsToParquet } from './parquet.js'
import { readJsonlRows } from './reader.js'

/**
 * @import { ResolvedUploadOptions, Signal, StorageConnector, UploadDeps, UploadJob, UploadResult } from './upload.d.ts'
 */

const SIGNALS = /** @type {const} */ (['logs', 'traces', 'metrics'])
/** Legacy standalone filename pattern: `<signal>-<YYYY-MM-DD>.jsonl`. */
const LEGACY_FILE_PATTERN = /^(logs|traces|metrics)-(\d{4}-\d{2}-\d{2})\.jsonl$/
/** New per-dimension layout filename pattern: `<YYYY-MM-DD>.jsonl`. */
const PARTITION_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.jsonl$/

/**
 * Fallback for callers that build a `ResolvedUploadOptions` by hand
 * (older tests, ad-hoc helpers) without going through `resolve()` in
 * `index.js`. Matches the default in that module so behavior is the
 * same on both paths.
 *
 * @type {ReadonlyArray<string>}
 */
const DEFAULT_PARTITION_DIMENSIONS = ['service', 'signal']

const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_INITIAL_BACKOFF_MS = 1000

/**
 * Find every JSONL file under `outputDir` that matches the configured
 * partition layout, is older than `today` (UTC), and falls within the
 * catch-up window. Filters to the configured signal allowlist.
 *
 * Two layouts are supported via `options.partitionDimensions`:
 *
 * 1. **Legacy standalone** (default `['service', 'signal']`): walks
 *    `<outputDir>/services/<service>/<signal>-<date>.jsonl`. Preserved
 *    so existing standalone installs (recorder + OTLP collector still
 *    write this layout) keep working unchanged.
 * 2. **Generic N-level** (any other value): walks
 *    `<outputDir>/<dim1>/<dim2>/.../<date>.jsonl`. Each directory level
 *    corresponds to one entry in `partitionDimensions`; the file name
 *    is the plain UTC date. The server-mode parquet drain uses
 *    `['gateway_id', 'signal']` to match the layout written by the
 *    NDJSON ingest endpoint.
 *
 * @param {string} outputDir
 * @param {string} today YYYY-MM-DD UTC
 * @param {ResolvedUploadOptions} options
 * @returns {UploadJob[]}
 */
export function discoverJobs(outputDir, today, options) {
  const dims = options.partitionDimensions ?? DEFAULT_PARTITION_DIMENSIONS
  if (isLegacyDimensions(dims)) {
    return discoverLegacyJobs(outputDir, today, options)
  }
  return discoverPartitionedJobs(outputDir, today, { ...options, partitionDimensions: dims })
}

/**
 * @param {ReadonlyArray<string>} dims
 * @returns {boolean}
 */
function isLegacyDimensions(dims) {
  return dims.length === 2 && dims[0] === 'service' && dims[1] === 'signal'
}

/**
 * @param {string} outputDir
 * @param {string} today
 * @param {ResolvedUploadOptions} options
 * @returns {UploadJob[]}
 */
function discoverLegacyJobs(outputDir, today, options) {
  const servicesDir = path.join(outputDir, 'services')
  if (!fs.existsSync(servicesDir)) return []

  const allowedSignals = new Set(options.signals)
  const minDate = subtractDays(today, options.catchupDays)

  /** @type {UploadJob[]} */
  const jobs = []
  for (const service of fs.readdirSync(servicesDir)) {
    const serviceDir = path.join(servicesDir, service)
    let entries
    try {
      entries = fs.readdirSync(serviceDir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const match = LEGACY_FILE_PATTERN.exec(entry)
      if (!match) continue
      const signal = /** @type {Signal} */ (match[1])
      const date = match[2]
      if (!allowedSignals.has(signal)) continue
      if (date >= today) continue
      if (date < minDate) continue
      jobs.push({
        partitions: { service, signal },
        signal,
        date,
        jsonlPath: path.join(serviceDir, entry),
        service,
      })
    }
  }
  return sortJobs(jobs, DEFAULT_PARTITION_DIMENSIONS)
}

/**
 * Walk an arbitrary N-level partition layout under `outputDir`. Missing
 * intermediate directories and unreadable subtrees are skipped silently
 * — the daily timer will retry, and a single bad subtree never fails
 * the run.
 *
 * @param {string} outputDir
 * @param {string} today
 * @param {ResolvedUploadOptions} options
 * @returns {UploadJob[]}
 */
function discoverPartitionedJobs(outputDir, today, options) {
  if (!fs.existsSync(outputDir)) return []

  const dims = options.partitionDimensions ?? DEFAULT_PARTITION_DIMENSIONS
  const allowedSignals = new Set(options.signals)
  const minDate = subtractDays(today, options.catchupDays)

  /** @type {UploadJob[]} */
  const jobs = []

  /**
   * @param {string} dir
   * @param {Record<string, string>} acc
   * @param {number} depth
   */
  function walk(dir, acc, depth) {
    if (depth === dims.length) {
      // Leaf: read `<date>.jsonl` files.
      let entries
      try {
        entries = fs.readdirSync(dir)
      } catch {
        return
      }
      for (const entry of entries) {
        const match = PARTITION_FILE_PATTERN.exec(entry)
        if (!match) continue
        const date = match[1]
        const { signal } = acc
        if (!signal || !allowedSignals.has(/** @type {Signal} */ (signal))) continue
        if (date >= today) continue
        if (date < minDate) continue
        /** @type {UploadJob} */
        const job = {
          partitions: { ...acc },
          signal: /** @type {Signal} */ (signal),
          date,
          jsonlPath: path.join(dir, entry),
        }
        if (typeof acc.service === 'string') job.service = acc.service
        jobs.push(job)
      }
      return
    }
    let names
    try {
      names = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    const dimName = dims[depth]
    for (const name of names) {
      if (!name.isDirectory()) continue
      walk(path.join(dir, name.name), { ...acc, [dimName]: name.name }, depth + 1)
    }
  }

  walk(outputDir, {}, 0)
  return sortJobs(jobs, dims)
}

/**
 * Upload one JSONL file as a Parquet object. Idempotent: skips if the
 * ledger or a HEAD on the destination shows the upload already
 * happened. Connector calls are retried with exponential backoff on
 * transient failures (network errors, 5xx, 429).
 *
 * Each row is tagged with `_partition` (the job's partition values)
 * before parquet conversion so downstream consumers can attribute the
 * row without trusting any client-supplied fields. The current parquet
 * schema does not surface `_partition` as typed columns; D.2 will add
 * `gateway_id` (etc.) as first-class columns and read it from there.
 *
 * @param {UploadJob} job
 * @param {ResolvedUploadOptions} options
 * @param {StorageConnector} connector
 * @param {string} outputDir
 * @param {Set<string>} committed In-memory ledger snapshot (mutated on success).
 * @param {UploadDeps} [deps]
 * @returns {Promise<{ uploaded: boolean, key: string, rows: number, size: number }>}
 */
export async function uploadJob(job, options, connector, outputDir, committed, deps = {}) {
  const dims = options.partitionDimensions ?? DEFAULT_PARTITION_DIMENSIONS
  const key = objectKey(options.prefix, dims, job)
  const resolved = resolveDeps(deps)

  if (isCommittedJob(committed, job)) {
    return { uploaded: false, key, rows: 0, size: 0 }
  }

  // Fallback existence check protects us if the ledger was lost.
  const head = await withRetry(() => connector.headObject(key), resolved)
  if (head !== undefined) {
    appendLedger(outputDir, {
      partitions: job.partitions,
      signal: job.signal,
      date: job.date,
      status: 'committed',
      key,
      size: head.size,
      rows: 0,
      committedAt: new Date().toISOString(),
      ...(job.partitions.service ? { service: job.partitions.service } : {}),
    })
    committed.add(jobLedgerKey(job))
    return { uploaded: false, key, rows: 0, size: head.size }
  }

  /** @type {Record<string, unknown>[]} */
  const rows = []
  for await (const row of readJsonlRows(job.jsonlPath)) {
    row._partition = { ...job.partitions }
    rows.push(row)
  }
  if (rows.length === 0) {
    return { uploaded: false, key, rows: 0, size: 0 }
  }

  const parquet = await rowsToParquet(job.signal, rows)
  await withRetry(() => connector.putObject(key, parquet, 'application/octet-stream'), resolved)

  appendLedger(outputDir, {
    partitions: job.partitions,
    signal: job.signal,
    date: job.date,
    status: 'committed',
    key,
    size: parquet.byteLength,
    rows: rows.length,
    committedAt: new Date().toISOString(),
    ...(job.partitions.service ? { service: job.partitions.service } : {}),
  })
  committed.add(jobLedgerKey(job))

  return { uploaded: true, key, rows: rows.length, size: parquet.byteLength }
}

/**
 * Upload every eligible job — used both by the daily timer and by
 * startup catch-up. Each job's connector calls are retried with
 * backoff; per-job failures (exhausted retries, permanent 4xx,
 * malformed JSONL, etc.) are logged and isolated so one bad file does
 * not abort the whole run, and the next tick will try again.
 *
 * @param {ResolvedUploadOptions} options
 * @param {StorageConnector} connector
 * @param {string} outputDir
 * @param {string} today YYYY-MM-DD UTC
 * @param {UploadDeps} [deps]
 * @returns {Promise<UploadResult[]>}
 */
export async function uploadPending(options, connector, outputDir, today, deps = {}) {
  const committed = readLedger(outputDir)
  const jobs = discoverJobs(outputDir, today, options)
  /** @type {UploadResult[]} */
  const results = []
  for (const job of jobs) {
    try {
      const result = await uploadJob(job, options, connector, outputDir, committed, deps)
      results.push({ job, ...result })
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      console.error(`[collectivus] upload failed for ${describeJob(job)}: ${error.message}`)
      const retryable = /** @type {{ transient?: unknown }} */ (error).transient === true
      results.push({ job, uploaded: false, key: '', rows: 0, size: 0, error, retryable })
    }
  }
  return results
}

/**
 * Retry a connector op on transient failures with exponential backoff.
 * An error is treated as transient unless it carries a non-429 4xx
 * `statusCode` — network errors, 5xx, and 429 are retried; permanent
 * 4xx (auth, malformed request) bail immediately.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {Required<UploadDeps>} deps
 * @returns {Promise<T>}
 */
async function withRetry(fn, deps) {
  let lastErr
  for (let attempt = 0; attempt < deps.maxAttempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (!isTransient(err)) throw err
      if (attempt === deps.maxAttempts - 1) break
      await deps.sleep(deps.initialBackoffMs * (4 ** attempt))
    }
  }
  // Exhausted retries on a transient connector error — tag it so the
  // outer catch in uploadPending knows the scheduler should fast-retry.
  // Errors thrown elsewhere in uploadJob (bad JSONL, encoding bugs, fs)
  // are never tagged and therefore never classified as retryable.
  if (lastErr && typeof lastErr === 'object') {
    /** @type {{ transient?: boolean }} */ (lastErr).transient = true
  }
  throw lastErr
}

/**
 * @param {unknown} err
 * @returns {boolean}
 */
function isTransient(err) {
  const status = /** @type {{ statusCode?: unknown }} */ (err)?.statusCode
  if (typeof status === 'number') {
    if (status === 429) return true
    return status >= 500 && status < 600
  }
  return true
}

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * @param {UploadDeps} deps
 * @returns {Required<UploadDeps>}
 */
function resolveDeps(deps) {
  return {
    maxAttempts: deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
    initialBackoffMs: deps.initialBackoffMs ?? DEFAULT_INITIAL_BACKOFF_MS,
    sleep: deps.sleep ?? defaultSleep,
  }
}

/**
 * Build the destination object key. Path segments are emitted in
 * `partitionDimensions` order so the S3 layout mirrors the on-disk
 * layout (`<gateway_id>/<signal>/...` for server,
 * `<service>/<signal>/...` for standalone).
 *
 * @param {string} prefix
 * @param {ReadonlyArray<string>} dims
 * @param {UploadJob} job
 * @returns {string}
 */
function objectKey(prefix, dims, job) {
  const head = prefix.replace(/^\/+|\/+$/g, '')
  const dimSegments = dims.map((d) => job.partitions[d])
  const segments = [...dimSegments, `date=${job.date}`, 'data.parquet']
  return head ? `${head}/${segments.join('/')}` : segments.join('/')
}

/**
 * Stable in-memory ledger key for a job. Mirrors the entry-based key
 * builder in `ledger.js` so a Set populated by `readLedger` matches
 * the keys this module uses to dedupe.
 *
 * @param {UploadJob} job
 * @returns {string}
 */
function jobLedgerKey(job) {
  const keys = Object.keys(job.partitions).sort()
  const kv = keys.map((k) => `${k}=${job.partitions[k]}`).join(';')
  return `${kv}|${job.date}`
}

/**
 * @param {UploadJob} job
 * @returns {string}
 */
function describeJob(job) {
  const dimDesc = Object.entries(job.partitions)
    .map(([k, v]) => `${k}=${v}`)
    .join('/')
  return `${dimDesc}/${job.date}`
}

/**
 * @param {UploadJob[]} jobs
 * @param {ReadonlyArray<string>} dims
 * @returns {UploadJob[]}
 */
function sortJobs(jobs, dims) {
  return jobs.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1
    for (const dim of dims) {
      if (dim === 'signal') continue
      const av = a.partitions[dim] ?? ''
      const bv = b.partitions[dim] ?? ''
      if (av !== bv) return av < bv ? -1 : 1
    }
    return SIGNALS.indexOf(a.signal) - SIGNALS.indexOf(b.signal)
  })
}

/**
 * Subtract `days` from a YYYY-MM-DD UTC date string.
 *
 * @param {string} date
 * @param {number} days
 * @returns {string}
 */
function subtractDays(date, days) {
  const d = new Date(`${date}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - days)
  return d.toISOString().slice(0, 10)
}

