import { loadClaudeContextLookup, sessionIdsFromExchanges } from '../cli/claude-transcripts.js'
import { walkExchanges } from '../cli/messages-walker.js'
import { reconstructAssistantMessage } from '../cli/stream-reconstruct.js'
import { iterExchangesWithStreamEvents } from '../upload/reader.js'
import {
  cachePartitionForSource,
  datasetsForSource,
  discoverSourceFiles,
  discoverGascityPartitions as expectedGascityPartitions,
  inspectCachePartition,
  listBuiltinCacheCursors,
  nextBuiltinCacheLocation,
} from './paths.js'
import { QUERY_CACHE_SCHEMA_VERSION, columnsForDataset, isQueryDataset } from './schema.js'
import { readCacheCursor, stableFingerprint, writeCacheCursor } from './iceberg/cursor.js'
import { readJsonlEntries } from './iceberg/jsonl.js'
import { appendRowsToTable, readRowsFromCursor } from './iceberg/store.js'

/**
 * @import { CachePartition, QueryDataset, QueryPaths, QueryScope, RefreshResult, SourceFile } from './types.js'
 * @import { BuiltinCacheCursor, QueryCacheCursor } from './iceberg/types.d.ts'
 */

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
  if (!paths.cacheEnabled || !paths.cacheDir) {
    throw new Error('query cache is disabled; pass --cache-dir to refresh explicitly')
  }

  /** @type {RefreshResult} */
  const result = { written: 0, skipped: 0, rows: 0, failures: 0, files: [] }
  const requestedDatasets = scope.datasets ?? (scope.dataset ? [scope.dataset] : undefined)
  const datasets = requestedDatasets?.filter(isQueryDataset)
  const wantsGascity = !datasets || datasets.includes('gascity_messages')
  if (wantsGascity) countGascityPartitions(scope, result, stdout)

  const otherDatasets = datasets ? datasets.filter((d) => d !== 'gascity_messages') : undefined
  const wantsOther = !datasets || (otherDatasets && otherDatasets.length > 0)
  if (!wantsOther) return result

  const sources = discoverSourceFiles(paths.recordingRoot, scope)
  for (const source of sources) {
    const sourceDatasets = datasetsForSource(source, otherDatasets)
    if (sourceDatasets.length === 0) continue
    if (source.signal === 'proxy') {
      await refreshProxySource(paths.cacheDir, source, sourceDatasets, force, result, stdout)
    } else {
      await refreshOtlpSource(paths.cacheDir, source, sourceDatasets, force, result, stdout)
    }
  }
  return result
}

/**
 * @param {QueryScope} scope
 * @param {RefreshResult} result
 * @param {{ write: (s: string) => void } | undefined} stdout
 * @returns {void}
 */
function countGascityPartitions(scope, result, stdout) {
  for (const partition of expectedGascityPartitions(scope)) {
    result.skipped++
    result.files.push({
      dataset: 'gascity_messages',
      gatewayId: partition.gatewayId,
      date: partition.date,
      rows: 0,
      cachePath: partition.cachePath,
      status: 'skipped',
    })
    stdout?.write(`fresh gascity_messages/${partition.date}/${partition.cachePath}\n`)
  }
}

/**
 * @param {string} cacheDir
 * @param {SourceFile} source
 * @param {QueryDataset[]} datasets
 * @param {boolean} force
 * @param {RefreshResult} result
 * @param {{ write: (s: string) => void } | undefined} stdout
 * @returns {Promise<void>}
 */
async function refreshOtlpSource(cacheDir, source, datasets, force, result, stdout) {
  const dataset = datasets[0]
  if (!dataset) return
  const partition = cachePartitionForSource(cacheDir, dataset, source)
  const state = inspectCachePartition(partition)
  if (!force && state.status === 'fresh') {
    pushSkipped(result, dataset, source, state.meta?.row_count ?? 0, partition.cachePath)
    stdout?.write(`fresh ${dataset}/${source.gatewayId}/${source.date}\n`)
    return
  }

  try {
    const columns = [...columnsForDataset(dataset)]
    const schemaFingerprint = stableFingerprint(columns)
    const existing = readBuiltinCursor(partition.cursorPath)
    const reset = shouldResetBuiltin(existing, schemaFingerprint, source.size, force)
    const location = reset
      ? nextBuiltinCacheLocation(cacheDir, dataset, source.gatewayId, source.date)
      : existingLocation(partition, existing)
    const epoch = reset ? epochFromTablePath(location.tablePath) : existing?.source_epoch ?? 0
    const startOffset = reset ? 0 : existing?.byte_offset ?? 0
    const startLine = reset ? 0 : existing?.line_number ?? 0
    const read = readJsonlEntries(source.jsonlPath, startOffset, startLine)
    if (!reset && read.nextByteOffset === startOffset && read.entries.length === 0) {
      pushSkipped(result, dataset, source, existing?.row_count ?? 0, partition.cachePath)
      stdout?.write(`fresh ${dataset}/${source.gatewayId}/${source.date}\n`)
      return
    }
    const sourceId = location.sourceId
    const rows = read.entries.map((entry) => ({
      ...entry.raw,
      gateway_id: source.gatewayId,
      date: source.date,
      _partition: { gateway_id: source.gatewayId },
      _ctvs_row_id: `${sourceId}:${epoch}:${entry.lineNumber}`,
      _ctvs_source_id: sourceId,
      _ctvs_source_epoch: epoch,
      _ctvs_byte_offset: entry.byteOffset,
      _ctvs_line_number: entry.lineNumber,
    }))
    await appendRowsToTable(location.tablePath, columns, rows)
    const rowCount = (reset ? 0 : existing?.row_count ?? 0) + rows.length
    writeCacheCursor(location.cursorPath, {
      cache_schema_version: QUERY_CACHE_SCHEMA_VERSION,
      kind: 'builtin',
      dataset,
      gateway_id: source.gatewayId,
      date: source.date,
      source_id: sourceId,
      source_path: source.jsonlPath,
      source_epoch: epoch,
      table_path: location.tablePath,
      table_url: location.tableUrl,
      source_size: read.nextByteOffset,
      source_mtime_ms: read.fileMtimeMs,
      byte_offset: read.nextByteOffset,
      line_number: read.nextLineNumber,
      row_count: rowCount,
      schema_fingerprint: schemaFingerprint,
      refreshed_at: new Date().toISOString(),
    })
    pushWritten(result, dataset, source, rows.length, location.cachePath)
    stdout?.write(`wrote ${location.cachePath} (${rows.length} rows)\n`)
  } catch (err) {
    pushFailed(result, dataset, source, partition.cachePath, err)
  }
}

/**
 * @param {string} cacheDir
 * @param {SourceFile} source
 * @param {QueryDataset[]} datasets
 * @param {boolean} force
 * @param {RefreshResult} result
 * @param {{ write: (s: string) => void } | undefined} stdout
 * @returns {Promise<void>}
 */
async function refreshProxySource(cacheDir, source, datasets, force, result, stdout) {
  if (!datasets.includes('proxy_messages')) return
  const dataset = /** @type {QueryDataset} */ ('proxy_messages')
  const partition = cachePartitionForSource(cacheDir, dataset, source)
  const state = inspectCachePartition(partition)
  if (!force && state.status === 'fresh') {
    pushSkipped(result, dataset, source, state.meta?.row_count ?? 0, partition.cachePath)
    stdout?.write(`fresh proxy_messages/${source.gatewayId}/${source.date}\n`)
    return
  }

  try {
    const columns = [...columnsForDataset(dataset)]
    const schemaFingerprint = stableFingerprint(columns)
    const existing = readBuiltinCursor(partition.cursorPath)
    const reset = shouldResetBuiltin(existing, schemaFingerprint, source.size, force)
    const location = reset
      ? nextBuiltinCacheLocation(cacheDir, dataset, source.gatewayId, source.date)
      : existingLocation(partition, existing)
    const epoch = reset ? epochFromTablePath(location.tablePath) : existing?.source_epoch ?? 0
    const sourceId = location.sourceId
    const read = readJsonlEntries(source.jsonlPath, 0, 0)

    const { seen, toolLookup } = await loadProxySeen(cacheDir, source.gatewayId, source.date, !reset)
    stdout?.write(`priorSeen proxy_messages/${source.gatewayId}/${source.date}: ${seen.size} messages, ${toolLookup.size} tool calls\n`)
    const bundles = await iterExchangesWithStreamEvents(source.jsonlPath)
    /** @type {Map<string, Record<string, unknown>[]>} */
    const streamEventsByExchange = new Map()
    for (const bundle of bundles) {
      const exchangeId = bundle.exchange.exchange_id
      if (typeof exchangeId === 'string') streamEventsByExchange.set(exchangeId, bundle.streamEvents)
    }
    const exchanges = bundles.map((bundle) => bundle.exchange)
    const contextLookup = await loadClaudeContextLookup({
      sessionIds: sessionIdsFromExchanges(exchanges),
    })
    const walked = walkExchanges(exchanges, {
      priorSeen: seen,
      gateway_id: source.gatewayId,
      contextLookup,
      reconstructAssistantMessage: (exchange) => {
        const exchangeId = exchange.exchange_id
        if (typeof exchangeId !== 'string') return null
        const events = streamEventsByExchange.get(exchangeId)
        if (!events) return null
        return reconstructAssistantMessage(/** @type {import('../cli/stream-reconstruct.js').StreamEventRow[]} */ (events))
      },
    })
    /** @type {Record<string, unknown>[]} */
    const rows = []
    for await (const row of walked) {
      const messageId = typeof row.message_id === 'string' ? row.message_id : 'message'
      const partIndex = typeof row.part_index === 'number' ? row.part_index : 0
      rows.push({
        ...row,
        date: source.date,
        _ctvs_row_id: `${sourceId}:${epoch}:${messageId}:${partIndex}`,
        _ctvs_source_id: sourceId,
        _ctvs_source_epoch: epoch,
        _ctvs_byte_offset: 0,
        _ctvs_line_number: 0,
      })
    }
    backfillToolNames(rows, toolLookup)
    await appendRowsToTable(location.tablePath, columns, rows)
    const rowCount = (reset ? 0 : existing?.row_count ?? 0) + rows.length
    writeCacheCursor(location.cursorPath, {
      cache_schema_version: QUERY_CACHE_SCHEMA_VERSION,
      kind: 'builtin',
      dataset,
      gateway_id: source.gatewayId,
      date: source.date,
      source_id: sourceId,
      source_path: source.jsonlPath,
      source_epoch: epoch,
      table_path: location.tablePath,
      table_url: location.tableUrl,
      source_size: read.nextByteOffset,
      source_mtime_ms: read.fileMtimeMs,
      byte_offset: read.nextByteOffset,
      line_number: read.nextLineNumber,
      row_count: rowCount,
      schema_fingerprint: schemaFingerprint,
      refreshed_at: new Date().toISOString(),
    })
    pushWritten(result, dataset, source, rows.length, location.cachePath)
    stdout?.write(`wrote ${location.cachePath} (${rows.length} rows)\n`)
  } catch (err) {
    pushFailed(result, dataset, source, partition.cachePath, err)
  }
}

/**
 * @param {string} cacheDir
 * @param {string} gatewayId
 * @param {string} date
 * @param {boolean} includeSameDate
 * @returns {Promise<{
 *   seen: Map<string, { conversation_id: string, message_index: number }>,
 *   toolLookup: Map<string, string>,
 * }>}
 */
async function loadProxySeen(cacheDir, gatewayId, date, includeSameDate) {
  /** @type {Map<string, { conversation_id: string, message_index: number }>} */
  const seen = new Map()
  /** @type {Map<string, string>} */
  const toolLookup = new Map()
  const cursors = listBuiltinCacheCursors(cacheDir, {
    datasets: ['proxy_messages'],
    gatewayId,
    limit: 100,
  }).filter((cursor) => cursor.date < date || (includeSameDate && cursor.date === date))
  for (const cursor of cursors) {
    const rows = await readRowsFromCursor(cursor)
    for (const row of rows) {
      const messageId = row.message_id
      const conversationId = row.conversation_id
      const messageIndex = row.message_index
      if (typeof messageId === 'string' && typeof conversationId === 'string' && typeof messageIndex === 'number' && !seen.has(messageId)) {
        seen.set(messageId, { conversation_id: conversationId, message_index: messageIndex })
      }
      if (
        row.part_type === 'tool_call' &&
        typeof row.tool_call_id === 'string' &&
        typeof row.tool_name === 'string' &&
        !toolLookup.has(row.tool_call_id)
      ) {
        toolLookup.set(row.tool_call_id, row.tool_name)
      }
    }
  }
  return { seen, toolLookup }
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {Map<string, string>} toolLookup
 * @returns {void}
 */
function backfillToolNames(rows, toolLookup) {
  if (toolLookup.size === 0) return
  for (const row of rows) {
    if (row.part_type !== 'tool_result') continue
    if (typeof row.tool_name === 'string' && row.tool_name.length > 0) continue
    const toolCallId = row.tool_call_id
    if (typeof toolCallId !== 'string') continue
    const name = toolLookup.get(toolCallId)
    if (name) row.tool_name = name
  }
}

/**
 * @param {string} cursorPath
 * @returns {BuiltinCacheCursor | undefined}
 */
function readBuiltinCursor(cursorPath) {
  const cursor = readCacheCursor(cursorPath)
  return cursor?.kind === 'builtin' ? cursor : undefined
}

/**
 * @param {BuiltinCacheCursor | undefined} cursor
 * @param {string} schemaFingerprint
 * @param {number} sourceSize
 * @param {boolean} force
 * @returns {boolean}
 */
function shouldResetBuiltin(cursor, schemaFingerprint, sourceSize, force) {
  if (force || !cursor) return true
  if (cursor.cache_schema_version !== QUERY_CACHE_SCHEMA_VERSION) return true
  if (cursor.schema_fingerprint !== schemaFingerprint) return true
  return sourceSize < cursor.byte_offset
}

/**
 * @param {CachePartition} partition
 * @param {BuiltinCacheCursor | undefined} cursor
 * @returns {{ cachePath: string, cursorPath: string, tablePath: string, tableUrl: string, sourceId: string }}
 */
function existingLocation(partition, cursor) {
  return {
    cachePath: partition.cachePath,
    cursorPath: partition.cursorPath,
    tablePath: cursor?.table_path ?? partition.tablePath,
    tableUrl: cursor?.table_url ?? partition.tableUrl,
    sourceId: cursor?.source_id ?? `${partition.dataset}:${partition.gatewayId}:${partition.date}`,
  }
}

/**
 * @param {string} tablePath
 * @returns {number}
 */
function epochFromTablePath(tablePath) {
  const match = /(?:^|[/\\])epoch=(\d+)$/.exec(tablePath)
  return match ? Number.parseInt(match[1], 10) : 0
}

/**
 * @param {RefreshResult} result
 * @param {string} dataset
 * @param {SourceFile} source
 * @param {number} rows
 * @param {string} cachePath
 */
function pushWritten(result, dataset, source, rows, cachePath) {
  result.written++
  result.rows += rows
  result.files.push({ dataset, gatewayId: source.gatewayId, date: source.date, rows, cachePath, status: 'written' })
}

/**
 * @param {RefreshResult} result
 * @param {string} dataset
 * @param {SourceFile} source
 * @param {number} rows
 * @param {string} cachePath
 */
function pushSkipped(result, dataset, source, rows, cachePath) {
  result.skipped++
  result.files.push({ dataset, gatewayId: source.gatewayId, date: source.date, rows, cachePath, status: 'skipped' })
}

/**
 * @param {RefreshResult} result
 * @param {string} dataset
 * @param {SourceFile} source
 * @param {string} cachePath
 * @param {unknown} err
 */
function pushFailed(result, dataset, source, cachePath, err) {
  result.failures++
  result.files.push({
    dataset,
    gatewayId: source.gatewayId,
    date: source.date,
    rows: 0,
    cachePath,
    status: 'failed',
    error: formatError(err),
  })
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}
