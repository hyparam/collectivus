import fs from 'node:fs'
import path from 'node:path'
import { parquetReadObjects } from 'hyparquet'
import { compressors } from 'hyparquet-compressors'
import { messageRowsToParquet } from '../cli/messages-parquet.js'
import { walkExchanges } from '../cli/messages-walker.js'
import { reconstructAssistantMessage } from '../cli/stream-reconstruct.js'
import { rowsToParquet } from '../upload/parquet.js'
import { iterExchangesWithStreamEvents, readPartitionRows } from '../upload/reader.js'
import {
  buildCacheMeta,
  cachePartitionForSource,
  datasetsForSource,
  discoverSourceFiles,
  inspectCachePartition,
  parquetPathFor,
} from './paths.js'

/**
 * @import { CachePartition, QueryDataset, QueryPaths, QueryScope, RefreshResult, SourceFile } from './types.js'
 */

const GATEWAY_PARTITION_DIMENSIONS = ['gateway_id']
const DATE_PARTITION_PATTERN = /^date=(\d{4}-\d{2}-\d{2})$/

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
 * Refresh the `proxy_messages` Parquet partition for one proxy JSONL file.
 *
 * The walker dedupes across days via `priorSeen` — message ids already
 * materialized in earlier date partitions for this gateway are loaded and
 * passed in, so a user message that re-appears in 50 history requests has
 * exactly one row in the final Parquet. The `tool_call_id → tool_name` map
 * is seeded from those same earlier partitions so a tool_result row whose
 * matching tool_use lives in yesterday's partition still resolves its name.
 *
 * @param {string} parquetDir
 * @param {SourceFile} source
 * @param {QueryDataset[]} datasets
 * @param {boolean} force
 * @param {RefreshResult} result
 * @param {{ write: (s: string) => void } | undefined} stdout
 * @returns {Promise<void>}
 */
async function refreshProxySource(parquetDir, source, datasets, force, result, stdout) {
  if (!datasets.includes('proxy_messages')) return
  const partition = cachePartitionForSource(parquetDir, 'proxy_messages', source)
  const state = inspectCachePartition(partition)
  if (!force && state.status === 'fresh') {
    result.skipped++
    result.files.push({
      dataset: 'proxy_messages',
      gatewayId: source.gatewayId,
      date: source.date,
      rows: state.meta?.row_count ?? 0,
      parquetPath: partition.parquetPath,
      status: 'skipped',
    })
    stdout?.write(`fresh proxy_messages/${source.gatewayId}/${source.date}\n`)
    return
  }

  try {
    const { seen, toolLookup } = await loadPriorSeen(parquetDir, source.gatewayId, source.date)
    stdout?.write(`priorSeen proxy_messages/${source.gatewayId}/${source.date}: ${seen.size} messages, ${toolLookup.size} tool calls\n`)
    const bundles = await iterExchangesWithStreamEvents(source.jsonlPath)
    /** @type {Map<string, Record<string, unknown>[]>} */
    const streamEventsByExchange = new Map()
    for (const bundle of bundles) {
      const exchangeId = bundle.exchange.exchange_id
      if (typeof exchangeId === 'string') {
        streamEventsByExchange.set(exchangeId, bundle.streamEvents)
      }
    }
    const exchanges = bundles.map((bundle) => bundle.exchange)
    const walked = walkExchanges(exchanges, {
      priorSeen: seen,
      gateway_id: source.gatewayId,
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
      rows.push(row)
    }
    // The walker tracks tool_call_id → tool_name within a single walk only;
    // tool_results whose matching tool_use lived in an earlier day's Parquet
    // are resolved here from the priorSeen-seeded lookup.
    backfillToolNames(rows, toolLookup)
    const buf = await messageRowsToParquet(rows, GATEWAY_PARTITION_DIMENSIONS, { allowEmpty: true })
    if (!buf) throw new Error('failed to encode proxy_messages partition')
    writeParquetAndMeta(partition, buf, rows.length)
    result.written++
    result.rows += rows.length
    result.files.push({
      dataset: 'proxy_messages',
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
      dataset: 'proxy_messages',
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
 * Build the `{message_id → {conversation_id, message_index}}` and
 * `{tool_call_id → tool_name}` maps from every Parquet partition in
 * `proxy_messages/gateway_id=<id>/date=<earlier-day>/` for the given
 * `gateway_id`. The check is a path-level filter — only date directories
 * lexicographically before `beforeDate` are read, so each refresh pays
 * the I/O cost for past days only.
 *
 * Returns empty maps when no prior partitions exist (first-ever refresh).
 *
 * @param {string} parquetDir
 * @param {string} gatewayId
 * @param {string} beforeDate  -- exclusive upper bound, ISO `YYYY-MM-DD`
 * @returns {Promise<{
 *   seen: Map<string, { conversation_id: string, message_index: number }>,
 *   toolLookup: Map<string, string>,
 * }>}
 */
async function loadPriorSeen(parquetDir, gatewayId, beforeDate) {
  /** @type {Map<string, { conversation_id: string, message_index: number }>} */
  const seen = new Map()
  /** @type {Map<string, string>} */
  const toolLookup = new Map()
  const datasetDir = path.join(parquetDir, 'proxy_messages', `gateway_id=${gatewayId}`)
  let entries
  try {
    entries = fs.readdirSync(datasetDir, { withFileTypes: true })
  } catch {
    return { seen, toolLookup }
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const match = DATE_PARTITION_PATTERN.exec(entry.name)
    if (!match) continue
    const date = match[1]
    if (date >= beforeDate) continue
    const parquetPath = parquetPathFor(parquetDir, 'proxy_messages', gatewayId, date)
    if (!fileExists(parquetPath)) continue
    const buf = fs.readFileSync(parquetPath)
    const file = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
    /** @type {Record<string, unknown>[]} */
    const rows = await parquetReadObjects({
      file,
      compressors,
      columns: ['message_id', 'conversation_id', 'message_index', 'tool_call_id', 'tool_name', 'part_type'],
    })
    for (const row of rows) {
      const messageId = row.message_id
      const conversationId = row.conversation_id
      const messageIndex = row.message_index
      if (typeof messageId === 'string' && typeof conversationId === 'string' && typeof messageIndex === 'number') {
        if (!seen.has(messageId)) {
          seen.set(messageId, { conversation_id: conversationId, message_index: messageIndex })
        }
      }
      const toolCallId = row.tool_call_id
      const toolName = row.tool_name
      const partType = row.part_type
      if (
        partType === 'tool_call' &&
        typeof toolCallId === 'string' &&
        typeof toolName === 'string' &&
        !toolLookup.has(toolCallId)
      ) {
        toolLookup.set(toolCallId, toolName)
      }
    }
  }
  return { seen, toolLookup }
}

/**
 * Resolve any `tool_result` rows whose `tool_name` is still null using the
 * cross-day lookup. The walker resolves intra-walk pairings on its own; this
 * pass picks up tool_results whose matching tool_use happened in an earlier
 * day's Parquet partition.
 *
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
 * @param {CachePartition} partition
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
 * @param {string} p
 * @returns {boolean}
 */
function fileExists(p) {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}
