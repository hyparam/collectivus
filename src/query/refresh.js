import fs from 'node:fs'
import path from 'node:path'
import { proxyRowsToParquet } from '../cli/proxy-parquet.js'
import { rowsToParquet } from '../upload/parquet.js'
import { readJsonlRows, readPartitionRows } from '../upload/reader.js'
import {
  buildCacheMeta,
  cachePartitionForSource,
  datasetsForSource,
  discoverSourceFiles,
  inspectCachePartition,
} from './paths.js'

/**
 * @import { QueryDataset, QueryPaths, QueryScope, RefreshResult, SourceFile } from './types.js'
 */

const GATEWAY_PARTITION_DIMENSIONS = ['gateway_id']

/**
 * @param {{
 *   paths: QueryPaths,
 *   scope: QueryScope,
 *   force?: boolean,
 *   stdout?: { write: (s: string) => void },
 * }} args
 * @returns {Promise<RefreshResult>}
 */
export async function refreshQueryCache(args) {
  const { paths, scope, force = false, stdout } = args
  if (!paths.parquetEnabled || !paths.parquetDir) {
    throw new Error('query parquet cache is disabled; pass --parquet-dir to refresh explicitly')
  }

  /** @type {RefreshResult} */
  const result = { written: 0, skipped: 0, rows: 0, failures: 0, files: [] }
  const datasets = scope.datasets ?? (scope.dataset ? [scope.dataset] : undefined)
  const sources = discoverSourceFiles(paths.recordingRoot, scope)
  for (const source of sources) {
    const sourceDatasets = datasetsForSource(source, datasets)
    if (sourceDatasets.length === 0) continue
    if (source.signal === 'proxy') {
      await refreshProxySource(paths.parquetDir, source, sourceDatasets, force, result, stdout)
    } else {
      await refreshOtlpSource(paths.parquetDir, source, sourceDatasets, force, result, stdout)
    }
  }
  return result
}

/**
 * @param {string} parquetDir
 * @param {SourceFile} source
 * @param {QueryDataset[]} datasets
 * @param {boolean} force
 * @param {RefreshResult} result
 * @param {{ write: (s: string) => void } | undefined} stdout
 * @returns {Promise<void>}
 */
async function refreshOtlpSource(parquetDir, source, datasets, force, result, stdout) {
  const dataset = datasets[0]
  if (!dataset) return
  const partition = cachePartitionForSource(parquetDir, dataset, source)
  const state = inspectCachePartition(partition)
  if (!force && state.status === 'fresh') {
    result.skipped++
    result.files.push({
      dataset,
      gatewayId: source.gatewayId,
      date: source.date,
      rows: state.meta?.row_count ?? 0,
      parquetPath: partition.parquetPath,
      status: 'skipped',
    })
    stdout?.write(`fresh ${dataset}/${source.gatewayId}/${source.date}\n`)
    return
  }

  try {
    /** @type {Record<string, unknown>[]} */
    const rows = []
    for await (const row of readPartitionRows(source.jsonlPath, { gateway_id: source.gatewayId })) {
      rows.push(row)
    }
    const buf = await rowsToParquet(/** @type {import('../upload/upload.d.ts').Signal} */ (source.signal), rows, GATEWAY_PARTITION_DIMENSIONS)
    writeParquetAndMeta(partition, buf, rows.length)
    result.written++
    result.rows += rows.length
    result.files.push({
      dataset,
      gatewayId: source.gatewayId,
      date: source.date,
      rows: rows.length,
      parquetPath: partition.parquetPath,
      status: 'written',
    })
    stdout?.write(`wrote ${partition.parquetPath} (${rows.length} rows)\n`)
  } catch (err) {
    result.failures++
    result.files.push({
      dataset,
      gatewayId: source.gatewayId,
      date: source.date,
      rows: 0,
      parquetPath: partition.parquetPath,
      status: 'failed',
      error: formatError(err),
    })
  }
}

/**
 * @param {string} parquetDir
 * @param {SourceFile} source
 * @param {QueryDataset[]} datasets
 * @param {boolean} force
 * @param {RefreshResult} result
 * @param {{ write: (s: string) => void } | undefined} stdout
 * @returns {Promise<void>}
 */
async function refreshProxySource(parquetDir, source, datasets, force, result, stdout) {
  /** @type {Map<QueryDataset, import('./types.js').CachePartition>} */
  const partitions = new Map()
  /** @type {Set<QueryDataset>} */
  const needsWrite = new Set()
  for (const dataset of datasets) {
    const partition = cachePartitionForSource(parquetDir, dataset, source)
    partitions.set(dataset, partition)
    const state = inspectCachePartition(partition)
    if (!force && state.status === 'fresh') {
      result.skipped++
      result.files.push({
        dataset,
        gatewayId: source.gatewayId,
        date: source.date,
        rows: state.meta?.row_count ?? 0,
        parquetPath: partition.parquetPath,
        status: 'skipped',
      })
      stdout?.write(`fresh ${dataset}/${source.gatewayId}/${source.date}\n`)
    } else {
      needsWrite.add(dataset)
    }
  }
  if (needsWrite.size === 0) return

  /** @type {Record<string, unknown>[]} */
  const exchangeRows = []
  /** @type {Record<string, unknown>[]} */
  const streamEventRows = []
  try {
    for await (const raw of readJsonlRows(source.jsonlPath)) {
      const row = /** @type {Record<string, unknown>} */ ({ ...raw, _partition: { gateway_id: source.gatewayId } })
      if (row.kind === 'exchange') exchangeRows.push(row)
      else if (row.kind === 'stream_event') streamEventRows.push(row)
    }
    await maybeWriteProxyDataset('proxy_exchanges', 'exchange', exchangeRows)
    await maybeWriteProxyDataset('proxy_stream_events', 'stream_event', streamEventRows)
  } catch (err) {
    for (const dataset of needsWrite) {
      const partition = partitions.get(dataset)
      if (!partition) continue
      result.failures++
      result.files.push({
        dataset,
        gatewayId: source.gatewayId,
        date: source.date,
        rows: 0,
        parquetPath: partition.parquetPath,
        status: 'failed',
        error: formatError(err),
      })
    }
  }

  /**
   * @param {QueryDataset} dataset
   * @param {'exchange' | 'stream_event'} kind
   * @param {Record<string, unknown>[]} rows
   * @returns {Promise<void>}
   */
  async function maybeWriteProxyDataset(dataset, kind, rows) {
    if (!needsWrite.has(dataset)) return
    const partition = partitions.get(dataset)
    if (!partition) return
    const buf = await proxyRowsToParquet(kind, rows, GATEWAY_PARTITION_DIMENSIONS, { allowEmpty: true })
    if (!buf) throw new Error(`failed to encode ${dataset}`)
    writeParquetAndMeta(partition, buf, rows.length)
    result.written++
    result.rows += rows.length
    result.files.push({
      dataset,
      gatewayId: source.gatewayId,
      date: source.date,
      rows: rows.length,
      parquetPath: partition.parquetPath,
      status: 'written',
    })
    stdout?.write(`wrote ${partition.parquetPath} (${rows.length} rows)\n`)
  }
}

/**
 * @param {import('./types.js').CachePartition} partition
 * @param {Uint8Array} buf
 * @param {number} rowCount
 */
function writeParquetAndMeta(partition, buf, rowCount) {
  fs.mkdirSync(path.dirname(partition.parquetPath), { recursive: true })
  fs.writeFileSync(partition.parquetPath, buf)
  const meta = buildCacheMeta(partition, rowCount)
  fs.writeFileSync(partition.metaPath, JSON.stringify(meta, null, 2) + '\n')
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}
