import { appendLedger, isCommitted, readLedger } from '../ledger.js'
import { readPartitionRows } from '../reader.js'
import { discoverJobs, resolveDeps, withRetry } from '../uploader.js'
import { createConnectorLister, createConnectorResolver } from './resolver.js'
import { icebergSchemaForSignal, partitionSpecForSignal, rowsToIcebergRecords } from './schema.js'

/**
 * @import { ResolvedUploadOptions, Signal, StorageConnector, UploadDeps, UploadJob, UploadResult } from '../upload.d.ts'
 * @import { Catalog, TableMetadata } from 'icebird/src/types.js'
 */

const VERSION_HINT_PATH = 'metadata/version-hint.text'

/**
 * Per-tick context shared across jobs: the lazily-loaded icebird module,
 * the icebird FileCatalog (which wraps the connector resolver), and the
 * cache of (service, signal) tables already known to exist in S3.
 *
 * @typedef {object} IcebergCtx
 * @property {typeof import('icebird')} icebird
 * @property {Catalog} catalog
 * @property {Set<string>} ensuredTables Keyed by `<service>/<signal>`.
 * @property {ResolvedUploadOptions} options
 */

/**
 * Iceberg-mode counterpart to `uploadPending` in `uploader.js`. Discovers
 * the same per-(service, signal, date) JSONL jobs, but appends each day's
 * rows as a new snapshot in a long-lived Iceberg table per (service,
 * signal) instead of writing a standalone Parquet object.
 *
 * @param {ResolvedUploadOptions} options
 * @param {StorageConnector} connector
 * @param {string} outputDir
 * @param {string} today YYYY-MM-DD UTC
 * @param {UploadDeps} [deps]
 * @returns {Promise<UploadResult[]>}
 */
export async function icebergUploadPending(options, connector, outputDir, today, deps = {}) {
  const committed = readLedger(outputDir)
  const jobs = discoverJobs(outputDir, today, options).filter((j) => j.signal !== 'proxy')
  if (jobs.length === 0) return []

  const ctx = await buildContext(options, connector)

  /** @type {UploadResult[]} */
  const results = []
  for (const job of jobs) {
    try {
      const result = await appendJob(job, ctx, connector, outputDir, committed, deps)
      results.push({ job, ...result })
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      console.error(`[collectivus] iceberg upload failed for ${job.service}/${job.signal}/${job.date}: ${error.message}`)
      const retryable = /** @type {{ transient?: unknown }} */ (error).transient === true
      results.push({ job, uploaded: false, key: '', rows: 0, size: 0, error, retryable })
    }
  }
  return results
}

/**
 * Lazily import icebird and build the FileCatalog wired to a connector-
 * backed resolver. This is the only entry point that imports icebird, so
 * base installs without iceberg mode never load it.
 *
 * @param {ResolvedUploadOptions} options
 * @param {StorageConnector} connector
 * @returns {Promise<IcebergCtx>}
 */
async function buildContext(options, connector) {
  const icebird = await import('icebird')
  const resolver = await createConnectorResolver({
    connector,
    bucket: options.bucket,
  })
  const lister = createConnectorLister({
    connector,
    bucket: options.bucket,
  })
  const catalog = icebird.fileCatalog({
    resolver,
    lister,
    conditionalCommits: true,
  })
  return {
    icebird,
    catalog,
    ensuredTables: new Set(),
    options,
  }
}

/**
 * Append one (service, signal, date) JSONL file as a new snapshot in the
 * (service, signal) Iceberg table. Idempotent via the same shared ledger
 * the parquet path uses — re-running the daily tick on already-committed
 * data is a no-op.
 *
 * @param {UploadJob} job
 * @param {IcebergCtx} ctx
 * @param {StorageConnector} connector
 * @param {string} outputDir
 * @param {Set<string>} committed
 * @param {UploadDeps} deps
 * @returns {Promise<{ uploaded: boolean, key: string, rows: number, size: number }>}
 */
async function appendJob(job, ctx, connector, outputDir, committed, deps) {
  const tableUrl = tableUrlFor(ctx.options, job.service, job.signal)
  if (isCommitted(committed, job.service, job.signal, job.date)) {
    return { uploaded: false, key: tableUrl, rows: 0, size: 0 }
  }

  /** @type {Record<string, unknown>[]} */
  const rows = []
  for await (const row of readPartitionRows(job.jsonlPath, job.partition)) {
    rows.push(row)
  }
  if (rows.length === 0) {
    return { uploaded: false, key: tableUrl, rows: 0, size: 0 }
  }

  const signal = /** @type {Signal} */ (job.signal)
  const records = rowsToIcebergRecords(signal, rows, job.date, ctx.options.partitionDimensions)

  await ensureTable(ctx, connector, job.service, job.signal, tableUrl, deps)

  const resolved = resolveDeps(deps)
  const updated = await withRetry(
    () => ctx.icebird.icebergAppend({
      catalog: ctx.catalog,
      tableUrl,
      records,
    }),
    resolved
  )

  const snapshotId = currentSnapshotId(updated)
  const entry = {
    service: job.service,
    signal: job.signal,
    date: job.date,
    status: /** @type {'committed'} */ ('committed'),
    key: snapshotId !== undefined ? `${tableUrl}#${snapshotId}` : tableUrl,
    size: 0,
    rows: rows.length,
    committedAt: new Date().toISOString(),
  }
  appendLedger(outputDir, entry)
  committed.add(`${job.service} ${job.signal} ${job.date}`)

  return { uploaded: true, key: entry.key, rows: rows.length, size: 0 }
}

/**
 * Lazily create the Iceberg table for one (service, signal). On first
 * call per process, HEAD `metadata/version-hint.text` via the connector
 * to decide whether to call `icebergCreateTable`. The result is cached
 * in `ctx.ensuredTables` so subsequent jobs skip the round trip.
 *
 * `conditionalCommits: true` makes the create itself safe under races —
 * a concurrent writer that already wrote `v1.metadata.json` will cause
 * our create to fail with 412/409, which we treat as "table already
 * exists" and proceed.
 *
 * @param {IcebergCtx} ctx
 * @param {StorageConnector} connector
 * @param {string} service
 * @param {string} signal
 * @param {string} tableUrl
 * @param {UploadDeps} deps
 * @returns {Promise<void>}
 */
async function ensureTable(ctx, connector, service, signal, tableUrl, deps) {
  const cacheKey = `${service}/${signal}`
  if (ctx.ensuredTables.has(cacheKey)) return

  const head = connector.headObject
  if (!head) throw new Error('iceberg uploader: connector lacks headObject')
  const versionHintKey = `${stripBucket(tableUrl, ctx.options.bucket)}/${VERSION_HINT_PATH}`
  const resolved = resolveDeps(deps)
  const exists = await withRetry(() => head.call(connector, versionHintKey), resolved)
  if (exists !== undefined) {
    ctx.ensuredTables.add(cacheKey)
    return
  }

  try {
    await ctx.icebird.icebergCreateTable({
      catalog: ctx.catalog,
      tableUrl,
      schema: icebergSchemaForSignal(
        /** @type {Signal} */ (signal),
        ctx.options.partitionDimensions
      ),
      partitionSpec: partitionSpecForSignal(),
      formatVersion: 3,
    })
  } catch (err) {
    const status = /** @type {{ statusCode?: number, status?: number }} */ (err)?.statusCode
      ?? /** @type {{ statusCode?: number, status?: number }} */ (err)?.status
    if (status === 412 || status === 409) {
      // Another writer created the table first — fine, we will append to it.
    } else {
      throw err
    }
  }
  ctx.ensuredTables.add(cacheKey)
}

/**
 * Build the `s3://...` URL of the Iceberg table for a (service, signal).
 *
 * @param {ResolvedUploadOptions} options
 * @param {string} service
 * @param {string} signal
 * @returns {string}
 */
function tableUrlFor(options, service, signal) {
  const prefix = options.prefix.replace(/^\/+|\/+$/g, '')
  const segments = [service, signal]
  const path = prefix ? `${prefix}/${segments.join('/')}` : segments.join('/')
  return `s3://${options.bucket}/${path}`
}

/**
 * @param {string} tableUrl
 * @param {string} bucket
 * @returns {string}
 */
function stripBucket(tableUrl, bucket) {
  const head = `s3://${bucket}/`
  if (!tableUrl.startsWith(head)) {
    throw new Error(`tableUrl ${tableUrl} does not start with bucket ${bucket}`)
  }
  return tableUrl.slice(head.length)
}

/**
 * @param {TableMetadata} metadata
 * @returns {string | undefined}
 */
function currentSnapshotId(metadata) {
  const id = metadata['current-snapshot-id']
  return id === undefined ? undefined : String(id)
}
