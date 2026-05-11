import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { defaultSinkDir as defaultServerIngestDir } from '../server/ingest.js'
import {
  QUERY_CACHE_SCHEMA_VERSION,
  QUERY_DATASETS,
  isQueryDataset,
  sourceSignalForDataset,
} from './schema.js'

/**
 * @import { CollectivusConfig } from '../types.js'
 * @import {
 *   CacheMeta,
 *   CachePartition,
 *   CachePartitionState,
 *   QueryDataset,
 *   QueryPaths,
 *   QueryScope,
 *   SourceFile,
 * } from './types.js'
 */

const DATE_FILE_PATTERN = /^(\d{4}-\d{2}-\d{2})\.jsonl$/
const GATEWAY_PARTITION_PATTERN = /^gateway_id=(.+)$/
const DATE_PARTITION_PATTERN = /^date=(\d{4}-\d{2}-\d{2})$/

/**
 * @param {CollectivusConfig} config
 * @returns {string | undefined}
 */
export function resolveRecordingRoot(config) {
  if (config.role === 'server') return config.server?.sink_dir ?? defaultServerIngestDir()
  return config.sink?.dir
}

/**
 * @param {CollectivusConfig} config
 * @param {string} recordingRoot
 * @param {string | undefined} explicitParquetDir
 * @returns {{ parquetDir?: string, parquetEnabled: boolean, explicitParquetDir: boolean }}
 */
export function resolveParquetSettings(config, recordingRoot, explicitParquetDir) {
  if (explicitParquetDir) {
    return { parquetDir: explicitParquetDir, parquetEnabled: true, explicitParquetDir: true }
  }
  const query = config.query
  const parquet = query?.parquet
  const enabled = parquet?.enabled !== false
  const parquetDir = parquet?.dir ?? path.join(recordingRoot, '.collectivus-query', 'parquet')
  return { parquetDir, parquetEnabled: enabled, explicitParquetDir: false }
}

/**
 * @param {CollectivusConfig} config
 * @param {string} configPath
 * @param {string | undefined} explicitParquetDir
 * @returns {QueryPaths}
 */
export function resolveQueryPaths(config, configPath, explicitParquetDir) {
  const recordingRoot = resolveRecordingRoot(config)
  if (!recordingRoot) {
    throw new Error('config has no local recording root; set sink.dir or server.sink_dir')
  }
  const parquet = resolveParquetSettings(config, recordingRoot, explicitParquetDir)
  return { config, configPath, recordingRoot, ...parquet }
}

/**
 * @param {string} parquetDir
 * @param {QueryDataset} dataset
 * @param {string} gatewayId
 * @param {string} date
 * @returns {string}
 */
export function partitionDir(parquetDir, dataset, gatewayId, date) {
  return path.join(parquetDir, dataset, `gateway_id=${gatewayId}`, `date=${date}`)
}

/**
 * @param {string} parquetDir
 * @param {QueryDataset} dataset
 * @param {string} gatewayId
 * @param {string} date
 * @returns {string}
 */
export function parquetPathFor(parquetDir, dataset, gatewayId, date) {
  return path.join(partitionDir(parquetDir, dataset, gatewayId, date), 'data.parquet')
}

/**
 * @param {string} parquetPath
 * @returns {string}
 */
export function metaPathForParquet(parquetPath) {
  return `${parquetPath}.meta.json`
}

/**
 * @param {string} parquetDir
 * @param {QueryDataset} dataset
 * @param {SourceFile} source
 * @returns {CachePartition}
 */
export function cachePartitionForSource(parquetDir, dataset, source) {
  const parquetPath = parquetPathFor(parquetDir, dataset, source.gatewayId, source.date)
  return {
    dataset,
    gatewayId: source.gatewayId,
    date: source.date,
    jsonlPath: source.jsonlPath,
    sourceSize: source.size,
    sourceMtimeMs: source.mtimeMs,
    parquetPath,
    metaPath: metaPathForParquet(parquetPath),
  }
}

/**
 * @param {SourceFile} source
 * @param {QueryDataset[] | undefined} datasets
 * @returns {QueryDataset[]}
 */
export function datasetsForSource(source, datasets) {
  /** @type {QueryDataset[]} */
  const out = []
  if (source.signal === 'proxy') {
    out.push('proxy_exchanges', 'proxy_stream_events')
  } else {
    out.push(source.signal)
  }
  if (!datasets || datasets.length === 0) return out
  return out.filter((dataset) => datasets.includes(dataset))
}

/**
 * @param {string} root
 * @param {QueryScope} scope
 * @returns {SourceFile[]}
 */
export function discoverSourceFiles(root, scope) {
  const datasets = scope.datasets ?? (scope.dataset ? [scope.dataset] : undefined)
  const wantedSignals = datasets
    ? new Set(datasets.map((dataset) => sourceSignalForDataset(dataset)))
    : new Set(['logs', 'traces', 'metrics', 'proxy'])
  /** @type {SourceFile[]} */
  const files = []
  const gatewayIds = scope.gatewayId ? [scope.gatewayId] : safeReadDir(root)
  for (const gatewayId of gatewayIds) {
    const idDir = path.join(root, gatewayId)
    if (!isDirectory(idDir)) continue
    for (const signal of ['logs', 'traces', 'metrics', 'proxy']) {
      if (!wantedSignals.has(signal)) continue
      const signalDir = path.join(idDir, signal)
      if (!isDirectory(signalDir)) continue
      for (const entry of safeReadDir(signalDir)) {
        const match = DATE_FILE_PATTERN.exec(entry)
        if (!match) continue
        const date = match[1]
        if (scope.date && date !== scope.date) continue
        const jsonlPath = path.join(signalDir, entry)
        const stat = safeStat(jsonlPath)
        if (!stat || !stat.isFile()) continue
        files.push({
          gatewayId,
          signal: /** @type {SourceFile['signal']} */ (signal),
          date,
          jsonlPath,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        })
      }
    }
  }
  files.sort(compareSourceFiles)
  return files
}

/**
 * @param {QueryPaths} paths
 * @param {QueryScope} scope
 * @returns {CachePartition[]}
 */
export function expectedCachePartitions(paths, scope) {
  if (!paths.parquetDir) return []
  const datasets = scope.datasets ?? (scope.dataset ? [scope.dataset] : undefined)
  /** @type {CachePartition[]} */
  const partitions = []
  for (const source of discoverSourceFiles(paths.recordingRoot, scope)) {
    for (const dataset of datasetsForSource(source, datasets)) {
      partitions.push(cachePartitionForSource(paths.parquetDir, dataset, source))
    }
  }
  return partitions
}

/**
 * @param {CachePartition} partition
 * @returns {CachePartitionState}
 */
export function inspectCachePartition(partition) {
  const parquetExists = isFile(partition.parquetPath)
  const meta = readCacheMeta(partition.metaPath)
  if (!parquetExists && !meta) {
    return { partition, status: 'missing', reason: 'parquet and metadata are missing' }
  }
  if (!parquetExists) {
    return { partition, status: 'stale', meta, reason: 'parquet file is missing' }
  }
  if (!meta) {
    return { partition, status: 'stale', reason: 'metadata sidecar is missing or invalid' }
  }
  const reason = staleReason(partition, meta)
  if (reason) return { partition, status: 'stale', meta, reason }
  return { partition, status: 'fresh', meta }
}

/**
 * @param {CachePartition[]} partitions
 * @returns {CachePartitionState[]}
 */
export function inspectCachePartitions(partitions) {
  return partitions.map((partition) => inspectCachePartition(partition))
}

/**
 * @param {CachePartitionState[]} states
 * @returns {boolean}
 */
export function hasUnfreshPartitions(states) {
  return states.some((state) => state.status !== 'fresh')
}

/**
 * @param {string} metaPath
 * @returns {CacheMeta | undefined}
 */
export function readCacheMeta(metaPath) {
  try {
    const raw = fs.readFileSync(metaPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return
    const meta = /** @type {Partial<CacheMeta>} */ (parsed)
    if (!isQueryDataset(meta.dataset)) return
    if (typeof meta.gateway_id !== 'string') return
    if (typeof meta.date !== 'string') return
    if (typeof meta.source_path !== 'string') return
    if (typeof meta.source_size !== 'number') return
    if (typeof meta.source_mtime_ms !== 'number') return
    if (typeof meta.row_count !== 'number') return
    if (typeof meta.refreshed_at !== 'string') return
    if (typeof meta.cache_schema_version !== 'number') return
    return /** @type {CacheMeta} */ (parsed)
  } catch {
    return undefined
  }
}

/**
 * @param {CachePartition} partition
 * @param {CacheMeta} meta
 * @returns {string | undefined}
 */
function staleReason(partition, meta) {
  if (meta.cache_schema_version !== QUERY_CACHE_SCHEMA_VERSION) return 'cache schema version changed'
  if (meta.dataset !== partition.dataset) return 'metadata dataset does not match partition'
  if (meta.gateway_id !== partition.gatewayId) return 'metadata gateway_id does not match partition'
  if (meta.date !== partition.date) return 'metadata date does not match partition'
  if (path.resolve(meta.source_path) !== path.resolve(partition.jsonlPath)) return 'metadata source path does not match source'
  if (meta.source_size !== partition.sourceSize) return 'source size changed'
  if (meta.source_mtime_ms !== partition.sourceMtimeMs) return 'source mtime changed'
}

/**
 * @param {string} parquetDir
 * @param {QueryScope} scope
 * @returns {CacheMeta[]}
 */
export function listCacheMetas(parquetDir, scope) {
  const datasets = scope.datasets ?? (scope.dataset ? [scope.dataset] : QUERY_DATASETS)
  /** @type {CacheMeta[]} */
  const out = []
  for (const dataset of datasets) {
    const datasetDir = path.join(parquetDir, dataset)
    for (const gatewayEntry of safeReadDir(datasetDir)) {
      const gatewayMatch = GATEWAY_PARTITION_PATTERN.exec(gatewayEntry)
      if (!gatewayMatch) continue
      const gatewayId = gatewayMatch[1]
      if (scope.gatewayId && gatewayId !== scope.gatewayId) continue
      const gatewayDir = path.join(datasetDir, gatewayEntry)
      for (const dateEntry of safeReadDir(gatewayDir)) {
        const dateMatch = DATE_PARTITION_PATTERN.exec(dateEntry)
        if (!dateMatch) continue
        const date = dateMatch[1]
        if (scope.date && date !== scope.date) continue
        const meta = readCacheMeta(path.join(gatewayDir, dateEntry, 'data.parquet.meta.json'))
        if (meta) out.push(meta)
      }
    }
  }
  out.sort(compareMetas)
  return out
}

/**
 * @param {CachePartition} partition
 * @param {number} rowCount
 * @returns {CacheMeta}
 */
export function buildCacheMeta(partition, rowCount) {
  return {
    cache_schema_version: QUERY_CACHE_SCHEMA_VERSION,
    dataset: partition.dataset,
    gateway_id: partition.gatewayId,
    date: partition.date,
    source_path: partition.jsonlPath,
    source_size: partition.sourceSize,
    source_mtime_ms: partition.sourceMtimeMs,
    row_count: rowCount,
    refreshed_at: new Date().toISOString(),
  }
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function safeReadDir(dir) {
  try {
    return fs.readdirSync(dir).sort()
  } catch {
    return []
  }
}

/**
 * @param {string} p
 * @returns {fs.Stats | undefined}
 */
function safeStat(p) {
  try {
    return fs.statSync(p)
  } catch {
    return undefined
  }
}

/**
 * @param {string} p
 * @returns {boolean}
 */
function isDirectory(p) {
  return safeStat(p)?.isDirectory() ?? false
}

/**
 * @param {string} p
 * @returns {boolean}
 */
function isFile(p) {
  return safeStat(p)?.isFile() ?? false
}

/**
 * @param {SourceFile} a
 * @param {SourceFile} b
 * @returns {number}
 */
function compareSourceFiles(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1
  if (a.gatewayId !== b.gatewayId) return a.gatewayId < b.gatewayId ? -1 : 1
  if (a.signal !== b.signal) return a.signal < b.signal ? -1 : 1
  return 0
}

/**
 * @param {CacheMeta} a
 * @param {CacheMeta} b
 * @returns {number}
 */
function compareMetas(a, b) {
  if (a.dataset !== b.dataset) return a.dataset < b.dataset ? -1 : 1
  if (a.date !== b.date) return a.date < b.date ? -1 : 1
  if (a.gateway_id !== b.gateway_id) return a.gateway_id < b.gateway_id ? -1 : 1
  return 0
}

/**
 * @returns {string}
 */
export function defaultHomeConfigPath() {
  return path.join(os.homedir(), '.hyp', 'collectivus.json')
}
