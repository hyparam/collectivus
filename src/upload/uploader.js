import fs from 'node:fs'
import path from 'node:path'
import { appendLedger, isCommitted, readLedger } from './ledger.js'
import { rowsToParquet } from './parquet.js'
import { readJsonlRows } from './reader.js'

/**
 * @import { ResolvedUploadOptions, Signal, StorageConnector, UploadDeps, UploadJob, UploadResult } from './upload.d.ts'
 */

const SIGNALS = /** @type {const} */ (['logs', 'traces', 'metrics'])
const FILE_PATTERN = /^(logs|traces|metrics)-(\d{4}-\d{2}-\d{2})\.jsonl$/

const DEFAULT_MAX_ATTEMPTS = 3
const DEFAULT_INITIAL_BACKOFF_MS = 1000

/**
 * Find every (service, signal, date) JSONL file under `<outputDir>/services/`
 * that is older than `today` (UTC) and within the catch-up window. Filters
 * to the configured signal allowlist.
 *
 * @param {string} outputDir
 * @param {string} today YYYY-MM-DD UTC
 * @param {ResolvedUploadOptions} options
 * @returns {UploadJob[]}
 */
export function discoverJobs(outputDir, today, options) {
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
      const match = FILE_PATTERN.exec(entry)
      if (!match) continue
      const signal = /** @type {Signal} */ (match[1])
      const date = match[2]
      if (!allowedSignals.has(signal)) continue
      if (date >= today) continue
      if (date < minDate) continue
      jobs.push({
        service,
        signal,
        date,
        jsonlPath: path.join(serviceDir, entry),
      })
    }
  }
  jobs.sort(jobCompare)
  return jobs
}

/**
 * Upload one (service, signal, date) JSONL file as a Parquet object.
 * Idempotent: skips if the ledger or a HEAD on the destination shows the
 * upload already happened. Connector calls are retried with exponential
 * backoff on transient failures (network errors, 5xx, 429).
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
  const key = objectKey(options.prefix, job)
  const resolved = resolveDeps(deps)

  if (isCommitted(committed, job.service, job.signal, job.date)) {
    return { uploaded: false, key, rows: 0, size: 0 }
  }

  // Fallback existence check protects us if the ledger was lost.
  const head = await withRetry(() => connector.headObject(key), resolved)
  if (head !== undefined) {
    const entry = {
      service: job.service,
      signal: job.signal,
      date: job.date,
      status: /** @type {'committed'} */ ('committed'),
      key,
      size: head.size,
      rows: 0,
      committedAt: new Date().toISOString(),
    }
    appendLedger(outputDir, entry)
    committed.add(`${job.service} ${job.signal} ${job.date}`)
    return { uploaded: false, key, rows: 0, size: head.size }
  }

  /** @type {Record<string, unknown>[]} */
  const rows = []
  for await (const row of readJsonlRows(job.jsonlPath)) {
    rows.push(row)
  }
  if (rows.length === 0) {
    return { uploaded: false, key, rows: 0, size: 0 }
  }

  const parquet = await rowsToParquet(job.signal, rows)
  await withRetry(() => connector.putObject(key, parquet, 'application/octet-stream'), resolved)

  const entry = {
    service: job.service,
    signal: job.signal,
    date: job.date,
    status: /** @type {'committed'} */ ('committed'),
    key,
    size: parquet.byteLength,
    rows: rows.length,
    committedAt: new Date().toISOString(),
  }
  appendLedger(outputDir, entry)
  committed.add(`${job.service} ${job.signal} ${job.date}`)

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
      console.error(`[collectivus] upload failed for ${job.service}/${job.signal}/${job.date}: ${error.message}`)
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
 * Build the destination object key.
 *
 * @param {string} prefix
 * @param {UploadJob} job
 * @returns {string}
 */
function objectKey(prefix, job) {
  const head = prefix.replace(/^\/+|\/+$/g, '')
  const segments = [job.service, job.signal, `date=${job.date}`, 'data.parquet']
  return head ? `${head}/${segments.join('/')}` : segments.join('/')
}

/**
 * @param {UploadJob} a
 * @param {UploadJob} b
 * @returns {number}
 */
function jobCompare(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1
  if (a.service !== b.service) return a.service < b.service ? -1 : 1
  return SIGNALS.indexOf(a.signal) - SIGNALS.indexOf(b.signal)
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
