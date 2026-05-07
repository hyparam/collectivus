import fs from 'node:fs'
import path from 'node:path'
import { appendLedger, isCommitted, readLedger } from './ledger.js'
import { rowsToParquet } from './parquet.js'
import { readJsonlRows } from './reader.js'

/**
 * @import { ResolvedUploadOptions, Signal, StorageConnector, UploadJob } from './upload.d.ts'
 */

const SIGNALS = /** @type {const} */ (['logs', 'traces', 'metrics'])
const FILE_PATTERN = /^(logs|traces|metrics)-(\d{4}-\d{2}-\d{2})\.jsonl$/

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
 * upload already happened.
 *
 * @param {UploadJob} job
 * @param {ResolvedUploadOptions} options
 * @param {StorageConnector} connector
 * @param {string} outputDir
 * @param {Set<string>} committed In-memory ledger snapshot (mutated on success).
 * @returns {Promise<{ uploaded: boolean, key: string, rows: number, size: number }>}
 */
export async function uploadJob(job, options, connector, outputDir, committed) {
  const key = objectKey(options.prefix, job)

  if (isCommitted(committed, job.service, job.signal, job.date)) {
    return { uploaded: false, key, rows: 0, size: 0 }
  }

  // Fallback existence check protects us if the ledger was lost.
  const head = await connector.headObject(key)
  if (head !== null) {
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
  await connector.putObject(key, parquet, 'application/octet-stream')

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
 * startup catch-up. Per-job failures (transient 5xx, permanent 4xx,
 * malformed JSONL, etc.) are logged and isolated so one bad file does
 * not abort the whole run; the next tick will retry the failed jobs.
 *
 * @param {ResolvedUploadOptions} options
 * @param {StorageConnector} connector
 * @param {string} outputDir
 * @param {string} today YYYY-MM-DD UTC
 * @returns {Promise<Array<{ job: UploadJob, uploaded: boolean, key: string, rows: number, size: number, error?: Error }>>}
 */
export async function uploadPending(options, connector, outputDir, today) {
  const committed = readLedger(outputDir)
  const jobs = discoverJobs(outputDir, today, options)
  /** @type {Array<{ job: UploadJob, uploaded: boolean, key: string, rows: number, size: number, error?: Error }>} */
  const results = []
  for (const job of jobs) {
    try {
      const result = await uploadJob(job, options, connector, outputDir, committed)
      results.push({ job, ...result })
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      console.error(`[collectivus] upload failed for ${job.service}/${job.signal}/${job.date}: ${error.message}`)
      results.push({ job, uploaded: false, key: '', rows: 0, size: 0, error })
    }
  }
  return results
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
