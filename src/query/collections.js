import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { QUERY_CACHE_SCHEMA_VERSION, isQueryDataset } from './schema.js'

/**
 * @import { ColumnSource } from 'hyparquet-writer'
 * @import {
 *   CollectionCacheMeta,
 *   CollectionCachePartition,
 *   CollectionColumnMeta,
 *   CollectionsManifest,
 *   JsonlCollection,
 *   QueryPaths,
 *   QueryScope,
 *   RefreshResult,
 * } from './types.js'
 */

const MANIFEST_VERSION = 1
/** @type {CollectionColumnMeta[]} */
const META_COLUMNS = [
  { name: '_ctvs_source_path', type: 'STRING', nullable: false },
  { name: '_ctvs_line_number', type: 'INT32', nullable: false },
  { name: '_ctvs_raw', type: 'JSON', nullable: false },
]

const RESERVED_SQL_WORDS = new Set([
  'all', 'and', 'as', 'by', 'distinct', 'false', 'from',
  'group', 'having', 'join', 'limit', 'not', 'null', 'offset',
  'on', 'or', 'order', 'select', 'true', 'union', 'where', 'with',
])

const TIMESTAMP_CANDIDATES = new Set([
  'timestamp',
  'time',
  'ts',
  'date',
  'datetime',
  'created_at',
  'createdat',
  'created',
  'created_time',
  'createdtime',
  'observed_timestamp',
  'observedtimestamp',
])

/**
 * @param {string} recordingRoot
 * @returns {string}
 */
export function collectionsManifestPath(recordingRoot) {
  return path.join(recordingRoot, '.collectivus-query', 'collections.json')
}

/**
 * @param {string} parquetDir
 * @param {string} table
 * @returns {string}
 */
export function collectionParquetPath(parquetDir, table) {
  return path.join(parquetDir, 'collections', table, 'data.parquet')
}

/**
 * @param {string} parquetDir
 * @param {string} table
 * @returns {string}
 */
export function collectionMetaPath(parquetDir, table) {
  return `${collectionParquetPath(parquetDir, table)}.meta.json`
}

/**
 * @param {string} value
 * @returns {string}
 */
export function normalizeTableName(value) {
  return normalizeSqlIdentifier(value, 'collection', 'table')
}

/**
 * @param {string} value
 * @returns {string}
 */
export function normalizeColumnName(value) {
  return normalizeSqlIdentifier(value, 'field', 'field')
}

/**
 * @param {string} value
 * @returns {boolean}
 */
export function isCollectionTableName(value) {
  return normalizeTableName(value) === value
}

/**
 * @param {string} recordingRoot
 * @returns {CollectionsManifest}
 */
export function readCollectionsManifest(recordingRoot) {
  const manifestPath = collectionsManifestPath(recordingRoot)
  let raw
  try {
    raw = fs.readFileSync(manifestPath, 'utf8')
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') {
      return emptyManifest()
    }
    throw err
  }

  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    throw new Error(`collection manifest ${manifestPath} is not valid JSON: ${formatError(err)}`)
  }
  return normalizeManifest(parsed, manifestPath)
}

/**
 * @param {string} recordingRoot
 * @param {CollectionsManifest} manifest
 * @returns {void}
 */
export function writeCollectionsManifest(recordingRoot, manifest) {
  const manifestPath = collectionsManifestPath(recordingRoot)
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
  const tmp = `${manifestPath}.tmp.${process.pid}.${Date.now()}`
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + '\n')
  fs.renameSync(tmp, manifestPath)
}

/**
 * @param {string} recordingRoot
 * @returns {JsonlCollection[]}
 */
export function listCollections(recordingRoot) {
  return collectionsFromManifest(readCollectionsManifest(recordingRoot))
}

/**
 * @param {CollectionsManifest} manifest
 * @returns {JsonlCollection[]}
 */
export function collectionsFromManifest(manifest) {
  return Object.values(manifest.collections).sort(compareCollections)
}

/**
 * @param {CollectionsManifest} manifest
 * @param {string} nameOrTable
 * @returns {JsonlCollection | undefined}
 */
export function findCollection(manifest, nameOrTable) {
  if (manifest.collections[nameOrTable]) return manifest.collections[nameOrTable]
  const normalized = normalizeTableName(nameOrTable)
  if (manifest.collections[normalized]) return manifest.collections[normalized]
  return collectionsFromManifest(manifest).find((collection) => collection.name === nameOrTable)
}

/**
 * @param {{
 *   recordingRoot: string,
 *   filePath: string,
 *   name: string,
 *   timestampColumn?: string,
 *   replace?: boolean,
 * }} args
 * @returns {JsonlCollection}
 */
export function registerCollection(args) {
  const { recordingRoot, name, timestampColumn, replace = false } = args
  const sourcePath = path.resolve(args.filePath)
  const stat = safeStat(sourcePath)
  if (!stat || !stat.isFile()) {
    throw new Error(`JSONL file not found: ${sourcePath}`)
  }

  const table = normalizeTableName(name)
  if (isQueryDataset(table)) {
    throw new Error(`collection table "${table}" conflicts with a built-in query dataset`)
  }

  const manifest = readCollectionsManifest(recordingRoot)
  const existing = manifest.collections[table]
  if (existing && !replace) {
    throw new Error(`collection "${table}" already exists; pass --replace to update it`)
  }

  const now = new Date().toISOString()
  const collection = {
    name,
    table,
    source_path: sourcePath,
    ...(timestampColumn ? { timestamp_column: timestampColumn } : {}),
    created_at: existing?.created_at ?? now,
    updated_at: now,
  }
  manifest.collections[table] = collection
  writeCollectionsManifest(recordingRoot, manifest)
  return collection
}

/**
 * @param {string} recordingRoot
 * @param {string} nameOrTable
 * @returns {JsonlCollection | undefined}
 */
export function removeCollection(recordingRoot, nameOrTable) {
  const manifest = readCollectionsManifest(recordingRoot)
  const collection = findCollection(manifest, nameOrTable)
  if (!collection) return undefined
  delete manifest.collections[collection.table]
  writeCollectionsManifest(recordingRoot, manifest)
  return collection
}

/**
 * @param {QueryPaths} paths
 * @param {QueryScope} scope
 * @returns {CollectionCachePartition[]}
 */
export function expectedCollectionPartitions(paths, scope) {
  if (!paths.parquetDir) return []
  const manifest = readCollectionsManifest(paths.recordingRoot)
  const wanted = collectionTablesForScope(manifest, scope)
  return wanted.map((collection) => collectionPartitionFor(paths.parquetDir, collection))
}

/**
 * @param {string} parquetDir
 * @param {JsonlCollection} collection
 * @returns {CollectionCachePartition}
 */
export function collectionPartitionFor(parquetDir, collection) {
  const stat = safeStat(collection.source_path)
  return {
    kind: 'collection',
    dataset: collection.table,
    table: collection.table,
    collection,
    jsonlPath: collection.source_path,
    sourceExists: Boolean(stat?.isFile()),
    sourceSize: stat?.isFile() ? stat.size : -1,
    sourceMtimeMs: stat?.isFile() ? stat.mtimeMs : -1,
    parquetPath: collectionParquetPath(parquetDir, collection.table),
    metaPath: collectionMetaPath(parquetDir, collection.table),
  }
}

/**
 * @param {QueryPaths} paths
 * @param {QueryScope} scope
 * @returns {JsonlCollection[]}
 */
export function collectionTablesForQuery(paths, scope) {
  const manifest = readCollectionsManifest(paths.recordingRoot)
  return collectionTablesForScope(manifest, scope)
}

/**
 * @param {CollectionCachePartition} partition
 * @returns {{ partition: CollectionCachePartition, status: 'fresh' | 'missing' | 'stale', meta?: CollectionCacheMeta, reason?: string }}
 */
export function inspectCollectionCachePartition(partition) {
  const parquetExists = isFile(partition.parquetPath)
  const meta = readCollectionCacheMeta(partition.metaPath)
  if (!parquetExists && !meta) {
    return { partition, status: 'missing', reason: 'parquet and metadata are missing' }
  }
  if (!parquetExists) {
    return { partition, status: 'stale', meta, reason: 'parquet file is missing' }
  }
  if (!meta) {
    return { partition, status: 'stale', reason: 'metadata sidecar is missing or invalid' }
  }
  const reason = collectionStaleReason(partition, meta)
  if (reason) return { partition, status: 'stale', meta, reason }
  return { partition, status: 'fresh', meta }
}

/**
 * @param {CollectionCachePartition[]} partitions
 * @returns {Array<ReturnType<typeof inspectCollectionCachePartition>>}
 */
export function inspectCollectionCachePartitions(partitions) {
  return partitions.map((partition) => inspectCollectionCachePartition(partition))
}

/**
 * @param {string} metaPath
 * @returns {CollectionCacheMeta | undefined}
 */
export function readCollectionCacheMeta(metaPath) {
  try {
    const raw = fs.readFileSync(metaPath, 'utf8')
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return
    const meta = /** @type {Partial<CollectionCacheMeta>} */ (parsed)
    if (meta.kind !== 'collection') return
    if (typeof meta.cache_schema_version !== 'number') return
    if (typeof meta.table !== 'string') return
    if (typeof meta.name !== 'string') return
    if (typeof meta.source_path !== 'string') return
    if (typeof meta.source_size !== 'number') return
    if (typeof meta.source_mtime_ms !== 'number') return
    if (typeof meta.row_count !== 'number') return
    if (typeof meta.refreshed_at !== 'string') return
    if (!Array.isArray(meta.columns)) return
    for (const column of meta.columns) {
      if (!column || typeof column !== 'object') return
      const col = /** @type {Partial<CollectionColumnMeta>} */ (column)
      if (typeof col.name !== 'string') return
      if (col.source_field !== undefined && typeof col.source_field !== 'string') return
      if (typeof col.type !== 'string') return
      if (typeof col.nullable !== 'boolean') return
    }
    if (meta.timestamp_column !== undefined && typeof meta.timestamp_column !== 'string') return
    return /** @type {CollectionCacheMeta} */ (parsed)
  } catch {
    return undefined
  }
}

/**
 * @param {{
 *   paths: QueryPaths,
 *   scope: QueryScope,
 *   force?: boolean,
 *   stdout?: { write: (s: string) => void },
 * }} args
 * @returns {Promise<RefreshResult>}
 */
export async function refreshCollectionCache(args) {
  const { paths, scope, force = false, stdout } = args
  if (!paths.parquetEnabled || !paths.parquetDir) {
    throw new Error('query parquet cache is disabled; pass --parquet-dir to refresh explicitly')
  }

  /** @type {RefreshResult} */
  const result = { written: 0, skipped: 0, rows: 0, failures: 0, files: [] }
  const partitions = expectedCollectionPartitions(paths, scope)
  for (const partition of partitions) {
    const state = inspectCollectionCachePartition(partition)
    if (!force && state.status === 'fresh') {
      result.skipped++
      result.files.push({
        dataset: /** @type {import('./types.js').QueryDataset} */ (partition.table),
        gatewayId: '',
        date: '',
        rows: state.meta?.row_count ?? 0,
        parquetPath: partition.parquetPath,
        status: 'skipped',
      })
      stdout?.write(`fresh ${partition.table}\n`)
      continue
    }

    try {
      if (!partition.sourceExists) throw new Error(`source JSONL file not found: ${partition.jsonlPath}`)
      const materialized = await materializeCollection(partition.collection, partition.jsonlPath)
      writeCollectionParquetAndMeta(partition, materialized)
      result.written++
      result.rows += materialized.rows.length
      result.files.push({
        dataset: /** @type {import('./types.js').QueryDataset} */ (partition.table),
        gatewayId: '',
        date: '',
        rows: materialized.rows.length,
        parquetPath: partition.parquetPath,
        status: 'written',
      })
      stdout?.write(`wrote ${partition.parquetPath} (${materialized.rows.length} rows)\n`)
    } catch (err) {
      result.failures++
      result.files.push({
        dataset: /** @type {import('./types.js').QueryDataset} */ (partition.table),
        gatewayId: '',
        date: '',
        rows: 0,
        parquetPath: partition.parquetPath,
        status: 'failed',
        error: formatError(err),
      })
    }
  }
  return result
}

/**
 * @param {CollectionCachePartition} partition
 * @param {{ rows: Record<string, unknown>[], columns: CollectionColumnMeta[], timestampColumn?: string, parquet: Uint8Array }} materialized
 * @returns {void}
 */
function writeCollectionParquetAndMeta(partition, materialized) {
  fs.mkdirSync(path.dirname(partition.parquetPath), { recursive: true })
  fs.writeFileSync(partition.parquetPath, materialized.parquet)
  /** @type {CollectionCacheMeta} */
  const meta = {
    cache_schema_version: QUERY_CACHE_SCHEMA_VERSION,
    kind: 'collection',
    table: partition.table,
    name: partition.collection.name,
    source_path: partition.jsonlPath,
    source_size: partition.sourceSize,
    source_mtime_ms: partition.sourceMtimeMs,
    row_count: materialized.rows.length,
    refreshed_at: new Date().toISOString(),
    columns: materialized.columns,
    ...(materialized.timestampColumn ? { timestamp_column: materialized.timestampColumn } : {}),
  }
  fs.writeFileSync(partition.metaPath, JSON.stringify(meta, null, 2) + '\n')
}

/**
 * @param {JsonlCollection} collection
 * @param {string} sourcePath
 * @returns {Promise<{ rows: Record<string, unknown>[], columns: CollectionColumnMeta[], timestampColumn?: string, parquet: Uint8Array }>}
 */
async function materializeCollection(collection, sourcePath) {
  const rawRows = await readCollectionRows(sourcePath)
  const columns = inferCollectionColumns(rawRows.map((row) => row.raw), collection.timestamp_column)
  const timestampColumn = resolveTimestampColumn(columns, collection.timestamp_column)
  const rows = rawRows.map((entry) => materializeRow(entry, columns, sourcePath))
  const parquet = await rowsToCollectionParquet(rows, columns)
  return { rows, columns, timestampColumn, parquet }
}

/**
 * @param {string} filePath
 * @returns {Promise<Array<{ lineNumber: number, raw: Record<string, unknown> }>>}
 */
async function readCollectionRows(filePath) {
  const stream = fs.createReadStream(filePath, { encoding: 'utf8' })
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
  /** @type {Array<{ lineNumber: number, raw: Record<string, unknown> }>} */
  const rows = []
  let lineNumber = 0
  for await (const line of rl) {
    lineNumber++
    if (!line) continue
    try {
      const parsed = JSON.parse(line)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        rows.push({ lineNumber, raw: /** @type {Record<string, unknown>} */ (parsed) })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      console.warn(`[collectivus] skipping malformed JSONL line ${filePath}:${lineNumber}: ${message}`)
    }
  }
  return rows
}

/**
 * @param {Record<string, unknown>[]} rawRows
 * @param {string | undefined} requestedTimestampColumn
 * @returns {CollectionColumnMeta[]}
 */
function inferCollectionColumns(rawRows, requestedTimestampColumn) {
  /** @type {CollectionColumnMeta[]} */
  const columns = [...META_COLUMNS]
  /** @type {Map<string, { sourceField: string, values: unknown[], present: number, nullable: boolean }>} */
  const stats = new Map()
  /** @type {Set<string>} */
  const usedNames = new Set(columns.map((column) => column.name))

  for (const raw of rawRows) {
    for (const [sourceField, value] of Object.entries(raw)) {
      let stat = stats.get(sourceField)
      if (!stat) {
        stat = {
          sourceField,
          values: [],
          present: 0,
          nullable: false,
        }
        stats.set(sourceField, stat)
      }
      stat.present++
      if (value === undefined || value === null) {
        stat.nullable = true
      } else {
        stat.values.push(value)
      }
    }
  }

  for (const stat of stats.values()) {
    const baseName = normalizeColumnName(stat.sourceField)
    const name = uniqueName(baseName, usedNames)
    usedNames.add(name)
    const nullable = stat.nullable || stat.present < rawRows.length
    columns.push({
      name,
      source_field: stat.sourceField,
      type: inferColumnType(stat.sourceField, name, stat.values, requestedTimestampColumn),
      nullable,
    })
  }
  return columns
}

/**
 * @param {string} sourceField
 * @param {string} columnName
 * @param {unknown[]} values
 * @param {string | undefined} requestedTimestampColumn
 * @returns {CollectionColumnMeta['type']}
 */
function inferColumnType(sourceField, columnName, values, requestedTimestampColumn) {
  if (values.length === 0) return 'JSON'
  const requested = requestedTimestampColumn && (
    requestedTimestampColumn === sourceField ||
    normalizeColumnName(requestedTimestampColumn) === columnName
  )
  if ((requested || isTimestampCandidate(sourceField) || isTimestampCandidate(columnName)) && values.every(isTimestampValue)) {
    return 'TIMESTAMP'
  }
  if (values.every((value) => typeof value === 'boolean')) return 'BOOLEAN'
  if (values.every((value) => typeof value === 'number' && Number.isFinite(value))) return 'DOUBLE'
  if (values.every((value) => typeof value === 'string')) return 'STRING'
  return 'JSON'
}

/**
 * @param {CollectionColumnMeta[]} columns
 * @param {string | undefined} requestedTimestampColumn
 * @returns {string | undefined}
 */
function resolveTimestampColumn(columns, requestedTimestampColumn) {
  if (requestedTimestampColumn) {
    const normalized = normalizeColumnName(requestedTimestampColumn)
    const requested = columns.find((column) => (
      column.source_field === requestedTimestampColumn ||
      column.name === requestedTimestampColumn ||
      column.name === normalized
    ))
    return requested?.name
  }
  const typed = columns.find((column) => column.type === 'TIMESTAMP' && (
    isTimestampCandidate(column.name) ||
    (column.source_field ? isTimestampCandidate(column.source_field) : false)
  ))
  return typed?.name
}

/**
 * @param {{ lineNumber: number, raw: Record<string, unknown> }} entry
 * @param {CollectionColumnMeta[]} columns
 * @param {string} sourcePath
 * @returns {Record<string, unknown>}
 */
function materializeRow(entry, columns, sourcePath) {
  /** @type {Record<string, unknown>} */
  const out = {
    _ctvs_source_path: sourcePath,
    _ctvs_line_number: entry.lineNumber,
    _ctvs_raw: entry.raw,
  }
  for (const column of columns) {
    if (!column.source_field) continue
    out[column.name] = entry.raw[column.source_field]
  }
  return out
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {CollectionColumnMeta[]} columns
 * @returns {Promise<Uint8Array>}
 */
async function rowsToCollectionParquet(rows, columns) {
  const { parquetWriteBuffer } = await import('hyparquet-writer')
  /** @type {ColumnSource[]} */
  const columnData = columns.map((column) => ({
    name: column.name,
    type: column.type,
    nullable: column.nullable,
    data: rows.map((row) => coerceCollectionCell(column, row[column.name])),
  }))
  const arrayBuffer = parquetWriteBuffer({ columnData })
  return new Uint8Array(arrayBuffer)
}

/**
 * @param {CollectionColumnMeta} column
 * @param {unknown} value
 * @returns {unknown}
 */
function coerceCollectionCell(column, value) {
  if (value === undefined || value === null) {
    if (!column.nullable) {
      throw new Error(`required column "${column.name}" got null`)
    }
    return undefined
  }
  switch (column.type) {
  case 'STRING':
    return typeof value === 'string' ? value : String(value)
  case 'INT32':
    return coerceInt32(value, column.name)
  case 'INT64':
    return coerceInt64(value, column.name)
  case 'DOUBLE':
    return coerceDouble(value, column.name)
  case 'BOOLEAN':
    return Boolean(value)
  case 'TIMESTAMP':
    return coerceTimestamp(value, column.name)
  case 'JSON':
    return value
  default:
    return value
  }
}

/**
 * @param {CollectionCachePartition} partition
 * @param {CollectionCacheMeta} meta
 * @returns {string | undefined}
 */
function collectionStaleReason(partition, meta) {
  if (meta.cache_schema_version !== QUERY_CACHE_SCHEMA_VERSION) return 'cache schema version changed'
  if (meta.kind !== 'collection') return 'metadata kind does not match partition'
  if (meta.table !== partition.table) return 'metadata table does not match partition'
  if (path.resolve(meta.source_path) !== path.resolve(partition.jsonlPath)) return 'metadata source path does not match source'
  if (!partition.sourceExists) return 'source file is missing'
  if (meta.source_size !== partition.sourceSize) return 'source size changed'
  if (meta.source_mtime_ms !== partition.sourceMtimeMs) return 'source mtime changed'
}

/**
 * @param {CollectionsManifest} manifest
 * @param {QueryScope} scope
 * @returns {JsonlCollection[]}
 */
function collectionTablesForScope(manifest, scope) {
  const all = collectionsFromManifest(manifest)
  const requested = scope.datasets ?? (scope.dataset ? [scope.dataset] : undefined)
  if (!requested) return all
  const wanted = new Set(requested.filter((dataset) => !isQueryDataset(dataset)))
  return all.filter((collection) => wanted.has(collection.table))
}

/**
 * @returns {CollectionsManifest}
 */
function emptyManifest() {
  return { version: MANIFEST_VERSION, collections: {} }
}

/**
 * @param {unknown} parsed
 * @param {string} manifestPath
 * @returns {CollectionsManifest}
 */
function normalizeManifest(parsed, manifestPath) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`collection manifest ${manifestPath} must be a JSON object`)
  }
  const obj = /** @type {Record<string, unknown>} */ (parsed)
  if (obj.version !== MANIFEST_VERSION) {
    throw new Error(`collection manifest ${manifestPath} has unsupported version ${JSON.stringify(obj.version)}`)
  }
  if (!obj.collections || typeof obj.collections !== 'object' || Array.isArray(obj.collections)) {
    throw new Error(`collection manifest ${manifestPath} is missing an object collections field`)
  }
  /** @type {CollectionsManifest} */
  const manifest = emptyManifest()
  for (const [table, value] of Object.entries(/** @type {Record<string, unknown>} */ (obj.collections))) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const collection = /** @type {Partial<JsonlCollection>} */ (value)
    if (typeof collection.name !== 'string') continue
    if (typeof collection.table !== 'string') continue
    if (collection.table !== table) continue
    if (typeof collection.source_path !== 'string') continue
    if (collection.timestamp_column !== undefined && typeof collection.timestamp_column !== 'string') continue
    if (typeof collection.created_at !== 'string') continue
    if (typeof collection.updated_at !== 'string') continue
    manifest.collections[table] = /** @type {JsonlCollection} */ (collection)
  }
  return manifest
}

/**
 * @param {string} value
 * @param {string} fallback
 * @param {'table' | 'field'} kind
 * @returns {string}
 */
function normalizeSqlIdentifier(value, fallback, kind) {
  let out = value.trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_')
  out = out.replace(/_+/g, '_').replace(/^_+|_+$/g, '')
  if (!out) out = fallback
  if (/^\d/.test(out)) out = `_${out}`
  if (RESERVED_SQL_WORDS.has(out)) out = kind === 'table' ? `${out}_table` : `${out}_field`
  return out
}

/**
 * @param {string} base
 * @param {Set<string>} used
 * @returns {string}
 */
function uniqueName(base, used) {
  if (!used.has(base)) return base
  let n = 2
  while (used.has(`${base}_${n}`)) n++
  return `${base}_${n}`
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isTimestampCandidate(value) {
  return TIMESTAMP_CANDIDATES.has(normalizeColumnName(value))
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isTimestampValue(value) {
  if (value instanceof Date) return !Number.isNaN(value.getTime())
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    return Number.isFinite(Date.parse(String(value)))
  }
  return false
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function coerceInt32(value, name) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const n = Number(value)
    if (Number.isFinite(n)) return Math.trunc(n)
  }
  throw new Error(`column "${name}" expected INT32, got ${typeof value}`)
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {bigint}
 */
function coerceInt64(value, name) {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number' && Number.isFinite(value)) return BigInt(Math.trunc(value))
  if (typeof value === 'string') return BigInt(value)
  throw new Error(`column "${name}" expected INT64, got ${typeof value}`)
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {number}
 */
function coerceDouble(value, name) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'bigint') return Number(value)
  if (typeof value === 'string') {
    const n = Number(value)
    if (Number.isFinite(n)) return n
  }
  throw new Error(`column "${name}" expected DOUBLE, got ${typeof value}`)
}

/**
 * @param {unknown} value
 * @param {string} name
 * @returns {Date}
 */
function coerceTimestamp(value, name) {
  if (value instanceof Date) return value
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'bigint') {
    const date = new Date(typeof value === 'bigint' ? Number(value) : value)
    if (!Number.isNaN(date.getTime())) return date
  }
  throw new Error(`column "${name}" expected TIMESTAMP, got ${typeof value}`)
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
function isFile(p) {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * @param {JsonlCollection} a
 * @param {JsonlCollection} b
 * @returns {number}
 */
function compareCollections(a, b) {
  return a.table < b.table ? -1 : a.table > b.table ? 1 : 0
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}
