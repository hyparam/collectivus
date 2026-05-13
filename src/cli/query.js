import fs from 'node:fs'
import process from 'node:process'
import { ConfigError, loadConfigAsync as defaultLoadConfig } from '../config.js'
import { defaultConfigPath } from './common.js'
import { readJsonlRows } from '../upload/reader.js'
import { renderResult } from '../query/format.js'
import {
  QUERY_DATASETS,
  assertQueryDataset,
  columnsForDataset,
} from '../query/schema.js'
import {
  discoverSourceFiles,
  expectedCachePartitions,
  inspectCachePartitions,
  resolveQueryPaths,
} from '../query/paths.js'
import { refreshQueryCache } from '../query/refresh.js'
import { executeLogicalSql, prepareReadOnlySql } from '../query/sql.js'

/**
 * @import { CollectivusConfig } from '../types.js'
 * @import {
 *   QueryDataset,
 *   QueryFormat,
 *   QueryPaths,
 *   QueryRefreshMode,
 *   QueryScope,
 * } from '../query/types.js'
 */

const USAGE = `Usage:
  ctvs query <command> [options]

Commands:
  status                         Inspect JSONL sources and query-cache freshness
  catalog                        List logical datasets and cached row counts
  schema <dataset>               Print the static logical schema
  refresh [dataset] [--force]    Materialize local JSONL into query-cache Parquet
  sql <select-sql>               Run read-only SELECT SQL over logical datasets
  sample <dataset>               Show sample rows
  doctor                         Check query prerequisites

  logs [count|tail]
  traces [slow|errors]
  trace <trace-id>
  metrics <list|series|latest|summary> [metric-name]
  proxy [get|events|stats|tail] [exchange-id]
  activity
  service <service-name>
  errors

Shared options:
  --config <path|url>            Config path or URL (default: ~/.hyp/collectivus.json)
  --parquet-dir <dir>            Query-cache directory
  --from <timestamp>             Inclusive timestamp lower bound
  --to <timestamp>               Inclusive timestamp upper bound
  --since <duration>             Relative lower bound, e.g. 15m, 2h, 7d
  --date <YYYY-MM-DD>            Restrict to one UTC date partition
  --gateway-id <id>              Restrict to one gateway id
  --service <name>               Restrict serviceName for OTLP datasets
  --limit <n>                    Max rows to render (default: 100, max: 1000)
  --format <fmt>                 table, json, jsonl, markdown
  --refresh <mode>               never or always (default: never).
                                 Stale partitions query with a stderr warning;
                                 missing partitions always error.
  --strict-freshness             Treat stale partitions as errors (pre-1.7 behavior)
  --help, -h                     Show this help`

const DEFAULT_LIMIT = 100
const MAX_LIMIT = 1000
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * @param {string[]} argv
 * @param {{
 *   stdout?: { write: (s: string) => void },
 *   stderr?: { write: (s: string) => void },
 *   loadConfig?: typeof defaultLoadConfig,
 * }} [hooks]
 * @returns {Promise<number>}
 */
export async function runQuery(argv, hooks = {}) {
  const stdout = hooks.stdout ?? process.stdout
  const stderr = hooks.stderr ?? process.stderr
  const parsed = parseQueryArgs(argv)
  if (parsed.help) {
    stdout.write(USAGE + '\n')
    return 0
  }
  if (parsed.error) {
    stderr.write(`error: ${parsed.error}\n\n${USAGE}\n`)
    return 2
  }
  const command = parsed.positionals[0]
  if (!command) {
    stdout.write(USAGE + '\n')
    return 0
  }

  if (command === 'schema') {
    return handleSchema(parsed, stdout, stderr)
  }

  /** @type {CollectivusConfig} */
  let config
  try {
    config = await (hooks.loadConfig ?? defaultLoadConfig)(parsed.configPath)
  } catch (err) {
    if (err instanceof ConfigError) {
      stderr.write(`config error: ${err.message}\n`)
      return 1
    }
    throw err
  }

  /** @type {QueryPaths} */
  let paths
  try {
    paths = resolveQueryPaths(config, parsed.configPath, parsed.parquetDir)
  } catch (err) {
    stderr.write(`error: ${formatError(err)}\n`)
    return 1
  }

  try {
    switch (command) {
    case 'status':
      return handleStatus(paths, parsed, stdout)
    case 'catalog':
      return handleCatalog(paths, parsed, stdout)
    case 'doctor':
      return handleDoctor(paths, parsed, stdout)
    case 'refresh':
      return handleRefresh(paths, parsed, stdout, stderr)
    case 'sql':
      return handleSql(paths, parsed, stdout, stderr)
    case 'sample':
      return handleSample(paths, parsed, stdout, stderr)
    case 'logs':
      return handleLogs(paths, parsed, stdout, stderr)
    case 'traces':
      return handleTraces(paths, parsed, stdout, stderr)
    case 'trace':
      return handleTrace(paths, parsed, stdout, stderr)
    case 'metrics':
      return handleMetrics(paths, parsed, stdout, stderr)
    case 'proxy':
      return handleProxy(paths, parsed, stdout, stderr)
    case 'activity':
      return executeGeneratedSql(paths, parsed, stdout, stderr, ['logs', 'traces', 'metrics', 'proxy_exchanges'], activitySql(parsed.limit))
    case 'service':
      return handleService(paths, parsed, stdout, stderr)
    case 'errors':
      return executeGeneratedSql(paths, parsed, stdout, stderr, ['logs', 'traces', 'proxy_exchanges'], errorsSql(parsed.limit))
    default:
      stderr.write(`error: unknown query command: ${command}\n\n${USAGE}\n`)
      return 2
    }
  } catch (err) {
    stderr.write(`error: ${formatError(err)}\n`)
    return 1
  }
}

/**
 * @param {string[]} argv
 * @returns {{
 *   help: boolean,
 *   positionals: string[],
 *   configPath: string,
 *   parquetDir?: string,
 *   from?: string,
 *   to?: string,
 *   date?: string,
 *   gatewayId?: string,
 *   service?: string,
 *   limit: number,
 *   format: QueryFormat,
 *   refresh: QueryRefreshMode,
 *   force: boolean,
 *   strictFreshness: boolean,
 *   error?: string,
 * }}
 */
export function parseQueryArgs(argv) {
  /** @type {ReturnType<typeof parseQueryArgs>} */
  const out = {
    help: false,
    positionals: [],
    configPath: defaultConfigPath(),
    limit: DEFAULT_LIMIT,
    format: 'table',
    refresh: 'never',
    force: false,
    strictFreshness: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') { out.help = true; return out }
    if (arg === '--force') { out.force = true; continue }
    if (arg === '--strict-freshness') { out.strictFreshness = true; continue }
    /**
     * @param {string} name
     * @returns {string | undefined}
     */
    function readValue(name) {
      const eq = `${name}=`
      if (arg.startsWith(eq)) return arg.slice(eq.length)
      if (arg === name) return argv[++i]
    }
    const configPath = readValue('--config')
    if (configPath !== undefined) {
      if (!configPath) { out.error = '--config requires a path or URL'; return out }
      out.configPath = configPath
      continue
    }
    const parquetDir = readValue('--parquet-dir')
    if (parquetDir !== undefined) {
      if (!parquetDir) { out.error = '--parquet-dir requires a directory'; return out }
      out.parquetDir = parquetDir
      continue
    }
    const from = readValue('--from')
    if (from !== undefined) {
      if (!from || Number.isNaN(Date.parse(from))) { out.error = '--from requires a parseable timestamp'; return out }
      out.from = new Date(from).toISOString()
      continue
    }
    const to = readValue('--to')
    if (to !== undefined) {
      if (!to || Number.isNaN(Date.parse(to))) { out.error = '--to requires a parseable timestamp'; return out }
      out.to = new Date(to).toISOString()
      continue
    }
    const since = readValue('--since')
    if (since !== undefined) {
      const ms = parseDurationMs(since)
      if (ms === undefined) { out.error = '--since requires a duration like 15m, 2h, or 7d'; return out }
      out.from = new Date(Date.now() - ms).toISOString()
      continue
    }
    const date = readValue('--date')
    if (date !== undefined) {
      if (!DATE_PATTERN.test(date)) { out.error = `--date must be YYYY-MM-DD, got ${date}`; return out }
      out.date = date
      continue
    }
    const gatewayId = readValue('--gateway-id')
    if (gatewayId !== undefined) {
      if (!gatewayId) { out.error = '--gateway-id requires an id'; return out }
      out.gatewayId = gatewayId
      continue
    }
    const service = readValue('--service')
    if (service !== undefined) {
      if (!service) { out.error = '--service requires a name'; return out }
      out.service = service
      continue
    }
    const limit = readValue('--limit')
    if (limit !== undefined) {
      const n = Number.parseInt(limit, 10)
      if (!Number.isInteger(n) || String(n) !== limit || n < 1 || n > MAX_LIMIT) {
        out.error = `--limit must be an integer between 1 and ${MAX_LIMIT}`
        return out
      }
      out.limit = n
      continue
    }
    const format = readValue('--format')
    if (format !== undefined) {
      if (!isQueryFormat(format)) { out.error = '--format must be table, json, jsonl, or markdown'; return out }
      out.format = format
      continue
    }
    const refresh = readValue('--refresh')
    if (refresh !== undefined) {
      if (refresh !== 'never' && refresh !== 'always') { out.error = '--refresh must be never or always'; return out }
      out.refresh = refresh
      continue
    }
    if (arg.startsWith('--')) {
      out.error = `unknown argument: ${arg}`
      return out
    }
    out.positionals.push(arg)
  }
  if (out.from && out.to && Date.parse(out.from) > Date.parse(out.to)) {
    out.error = '--from must be before --to'
  }
  return out
}

/**
 * @param {unknown} value
 * @returns {value is QueryFormat}
 */
function isQueryFormat(value) {
  return value === 'table' || value === 'json' || value === 'jsonl' || value === 'markdown'
}

/**
 * @param {QueryPaths} paths
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @param {{ write: (s: string) => void }} stdout
 * @returns {number}
 */
function handleStatus(paths, parsed, stdout) {
  const rows = statusRows(paths, baseScope(parsed))
  stdout.write(renderResult({ columns: ['dataset', 'sources', 'fresh', 'stale', 'missing', 'rows'], rows }, parsed.format))
  return 0
}

/**
 * @param {QueryPaths} paths
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @param {{ write: (s: string) => void }} stdout
 * @returns {number}
 */
function handleCatalog(paths, parsed, stdout) {
  const scope = baseScope(parsed)
  const sourceRows = statusRows(paths, scope)
  const rows = QUERY_DATASETS.map((dataset) => {
    const status = sourceRows.find((row) => row.dataset === dataset)
    return {
      dataset,
      source_signal: dataset.startsWith('proxy_') ? 'proxy' : dataset,
      columns: columnsForDataset(dataset).length,
      source_partitions: status?.sources ?? 0,
      cached_rows: status?.rows ?? 0,
    }
  })
  stdout.write(renderResult({ columns: ['dataset', 'source_signal', 'columns', 'source_partitions', 'cached_rows'], rows }, parsed.format))
  return 0
}

/**
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @param {{ write: (s: string) => void }} stdout
 * @param {{ write: (s: string) => void }} stderr
 * @returns {number}
 */
function handleSchema(parsed, stdout, stderr) {
  const raw = parsed.positionals[1]
  if (!raw) {
    stderr.write('error: schema requires a dataset\n')
    return 2
  }
  let dataset
  try {
    dataset = assertQueryDataset(raw)
  } catch (err) {
    stderr.write(`error: ${formatError(err)}\n`)
    return 2
  }
  const rows = columnsForDataset(dataset).map((column) => ({
    name: column.name,
    type: column.type,
    nullable: column.nullable,
  }))
  stdout.write(renderResult({ columns: ['name', 'type', 'nullable'], rows }, parsed.format))
  return 0
}

/**
 * @param {QueryPaths} paths
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @param {{ write: (s: string) => void }} stdout
 * @param {{ write: (s: string) => void }} stderr
 * @returns {Promise<number>}
 */
async function handleRefresh(paths, parsed, stdout, stderr) {
  const scope = scopeWithOptionalDataset(parsed, parsed.positionals[1])
  if (!paths.parquetEnabled || !paths.parquetDir) {
    stderr.write('error: query parquet cache is disabled; pass --parquet-dir to refresh explicitly\n')
    return 1
  }
  const result = await refreshQueryCache({ paths, scope, force: parsed.force, stdout })
  if (result.written === 0 && result.skipped === 0 && result.failures === 0) {
    stdout.write(`No JSONL files matched in ${paths.recordingRoot}.\n`)
  }
  stdout.write(`Done. ${result.written} file(s) written, ${result.skipped} fresh, ${result.rows} row(s)${result.failures ? `, ${result.failures} failure(s)` : ''}.\n`)
  return result.failures === 0 ? 0 : 1
}

/**
 * @param {QueryPaths} paths
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @param {{ write: (s: string) => void }} stdout
 * @param {{ write: (s: string) => void }} stderr
 * @returns {Promise<number>}
 */
async function handleSql(paths, parsed, stdout, stderr) {
  const sql = parsed.positionals.slice(1).join(' ')
  let prepared
  try {
    prepared = prepareReadOnlySql(sql, parsed.limit)
  } catch (err) {
    stderr.write(`error: ${formatError(err)}\n`)
    return 2
  }
  return executePrepared(paths, parsed, stdout, stderr, prepared.datasets, prepared.statement)
}

/**
 * @param {QueryPaths} paths
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @param {{ write: (s: string) => void }} stdout
 * @param {{ write: (s: string) => void }} stderr
 * @returns {Promise<number>}
 */
async function handleSample(paths, parsed, stdout, stderr) {
  const raw = parsed.positionals[1]
  if (!raw) {
    stderr.write('error: sample requires a dataset\n')
    return 2
  }
  let dataset
  try {
    dataset = assertQueryDataset(raw)
  } catch (err) {
    stderr.write(`error: ${formatError(err)}\n`)
    return 2
  }
  return executeGeneratedSql(paths, parsed, stdout, stderr, [dataset], `select * from ${dataset} limit ${parsed.limit}`)
}

/**
 * @param {QueryPaths} paths
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @param {{ write: (s: string) => void }} stdout
 * @returns {number}
 */
function handleDoctor(paths, parsed, stdout) {
  const rootExists = fs.existsSync(paths.recordingRoot)
  const scope = baseScope(parsed)
  const sources = discoverSourceFiles(paths.recordingRoot, scope)
  const states = paths.parquetEnabled && paths.parquetDir
    ? inspectCachePartitions(expectedCachePartitions(paths, scope))
    : []
  const unfresh = states.filter((state) => state.status !== 'fresh')
  const rows = [
    { check: 'config', status: 'ok', detail: paths.configPath },
    { check: 'recording_root', status: rootExists ? 'ok' : 'warn', detail: paths.recordingRoot },
    { check: 'query_cache', status: paths.parquetEnabled ? 'ok' : 'warn', detail: paths.parquetDir ?? 'disabled' },
    { check: 'source_partitions', status: 'ok', detail: String(sources.length) },
    { check: 'cache_freshness', status: unfresh.length === 0 ? 'ok' : 'warn', detail: `${unfresh.length} missing/stale partition(s)` },
  ]
  stdout.write(renderResult({ columns: ['check', 'status', 'detail'], rows }, parsed.format))
  return 0
}

/**
 * @param {QueryPaths} paths
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @param {{ write: (s: string) => void }} stdout
 * @param {{ write: (s: string) => void }} stderr
 * @returns {Promise<number>}
 */
async function handleLogs(paths, parsed, stdout, stderr) {
  const sub = parsed.positionals[1]
  if (sub === 'tail') {
    return renderLiveTail(paths, parsed, stdout, 'logs')
  }
  if (sub === 'count') {
    return executeGeneratedSql(paths, parsed, stdout, stderr, ['logs'], 'select count(*) as count from logs')
  }
  if (sub) {
    stderr.write(`error: unknown logs command: ${sub}\n`)
    return 2
  }
  return executeGeneratedSql(
    paths,
    parsed,
    stdout,
    stderr,
    ['logs'],
    `select gateway_id, date, timestamp, severityText, serviceName, body, traceId, spanId from logs order by timestamp desc limit ${parsed.limit}`
  )
}

/**
 * @param {QueryPaths} paths
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @param {{ write: (s: string) => void }} stdout
 * @param {{ write: (s: string) => void }} stderr
 * @returns {Promise<number>}
 */
async function handleTraces(paths, parsed, stdout, stderr) {
  const sub = parsed.positionals[1]
  if (sub === 'slow') {
    return executeGeneratedSql(
      paths,
      parsed,
      stdout,
      stderr,
      ['traces'],
      `select gateway_id, date, startTimestamp, durationMs, serviceName, name, traceId, spanId from traces order by durationMs desc limit ${parsed.limit}`
    )
  }
  if (sub === 'errors') {
    return executeGeneratedSql(
      paths,
      parsed,
      stdout,
      stderr,
      ['traces'],
      `select gateway_id, date, startTimestamp, serviceName, name, traceId, spanId, status from traces where JSON_VALUE(status, '$.code') = 2 order by startTimestamp desc limit ${parsed.limit}`
    )
  }
  if (sub) {
    stderr.write(`error: unknown traces command: ${sub}\n`)
    return 2
  }
  return executeGeneratedSql(
    paths,
    parsed,
    stdout,
    stderr,
    ['traces'],
    `select gateway_id, date, startTimestamp, durationMs, serviceName, name, traceId, spanId, status from traces order by startTimestamp desc limit ${parsed.limit}`
  )
}

/**
 * @param {QueryPaths} paths
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @param {{ write: (s: string) => void }} stdout
 * @param {{ write: (s: string) => void }} stderr
 * @returns {Promise<number>}
 */
async function handleTrace(paths, parsed, stdout, stderr) {
  const traceId = parsed.positionals[1]
  if (!traceId) {
    stderr.write('error: trace requires a trace id\n')
    return 2
  }
  return executeGeneratedSql(
    paths,
    parsed,
    stdout,
    stderr,
    ['traces'],
    `select * from traces where traceId = ${sqlString(traceId)} order by startTimestamp asc limit ${parsed.limit}`
  )
}

/**
 * @param {QueryPaths} paths
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @param {{ write: (s: string) => void }} stdout
 * @param {{ write: (s: string) => void }} stderr
 * @returns {Promise<number>}
 */
async function handleMetrics(paths, parsed, stdout, stderr) {
  const sub = parsed.positionals[1]
  const metricName = parsed.positionals[2]
  if (sub === 'list') {
    return executeGeneratedSql(
      paths,
      parsed,
      stdout,
      stderr,
      ['metrics'],
      `select metricName, count(*) as points from metrics group by metricName order by metricName limit ${parsed.limit}`
    )
  }
  if (sub === 'series') {
    if (!metricName) {
      stderr.write('error: metrics series requires a metric name\n')
      return 2
    }
    return executeGeneratedSql(
      paths,
      parsed,
      stdout,
      stderr,
      ['metrics'],
      `select gateway_id, date, timestamp, serviceName, metricName, value, valueInt, count, sum from metrics where metricName = ${sqlString(metricName)} order by timestamp asc limit ${parsed.limit}`
    )
  }
  if (sub === 'latest') {
    const where = metricName ? ` where metricName = ${sqlString(metricName)}` : ''
    return executeGeneratedSql(
      paths,
      parsed,
      stdout,
      stderr,
      ['metrics'],
      `select gateway_id, date, timestamp, serviceName, metricName, value, valueInt, count, sum from metrics${where} order by timestamp desc limit ${metricName ? parsed.limit : 1}`
    )
  }
  if (sub === 'summary') {
    if (!metricName) {
      stderr.write('error: metrics summary requires a metric name\n')
      return 2
    }
    return executeGeneratedSql(
      paths,
      parsed,
      stdout,
      stderr,
      ['metrics'],
      `select metricName, count(*) as points, min(value) as min_value, max(value) as max_value, avg(value) as avg_value, min(timestamp) as first_timestamp, max(timestamp) as last_timestamp from metrics where metricName = ${sqlString(metricName)} group by metricName`
    )
  }
  stderr.write('error: metrics requires list, series, latest, or summary\n')
  return 2
}

/**
 * @param {QueryPaths} paths
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @param {{ write: (s: string) => void }} stdout
 * @param {{ write: (s: string) => void }} stderr
 * @returns {Promise<number>}
 */
async function handleProxy(paths, parsed, stdout, stderr) {
  const sub = parsed.positionals[1]
  const exchangeId = parsed.positionals[2]
  if (sub === 'tail') {
    return renderLiveTail(paths, parsed, stdout, 'proxy_exchanges')
  }
  if (sub === 'get') {
    if (!exchangeId) {
      stderr.write('error: proxy get requires an exchange id\n')
      return 2
    }
    return executeGeneratedSql(
      paths,
      parsed,
      stdout,
      stderr,
      ['proxy_exchanges'],
      `select * from proxy_exchanges where exchangeId = ${sqlString(exchangeId)} limit ${parsed.limit}`
    )
  }
  if (sub === 'events') {
    if (!exchangeId) {
      stderr.write('error: proxy events requires an exchange id\n')
      return 2
    }
    return executeGeneratedSql(
      paths,
      parsed,
      stdout,
      stderr,
      ['proxy_stream_events'],
      `select * from proxy_stream_events where exchangeId = ${sqlString(exchangeId)} order by tMs asc limit ${parsed.limit}`
    )
  }
  if (sub === 'stats') {
    return executeGeneratedSql(
      paths,
      parsed,
      stdout,
      stderr,
      ['proxy_exchanges'],
      `select upstream, responseStatus, count(*) as exchanges, avg(durationMs) as avg_duration_ms, max(durationMs) as max_duration_ms from proxy_exchanges group by upstream, responseStatus order by exchanges desc limit ${parsed.limit}`
    )
  }
  if (sub) {
    stderr.write(`error: unknown proxy command: ${sub}\n`)
    return 2
  }
  return executeGeneratedSql(
    paths,
    parsed,
    stdout,
    stderr,
    ['proxy_exchanges'],
    `select gateway_id, date, tsStart, durationMs, upstream, responseStatus, requestMethod, requestPath, exchangeId, error from proxy_exchanges order by tsStart desc limit ${parsed.limit}`
  )
}

/**
 * @param {QueryPaths} paths
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @param {{ write: (s: string) => void }} stdout
 * @param {{ write: (s: string) => void }} stderr
 * @returns {Promise<number>}
 */
async function handleService(paths, parsed, stdout, stderr) {
  const service = parsed.positionals[1]
  if (!service) {
    stderr.write('error: service requires a service name\n')
    return 2
  }
  const scoped = { ...parsed, service }
  return executeGeneratedSql(paths, scoped, stdout, stderr, ['logs', 'traces', 'metrics'], serviceSql(parsed.limit))
}

/**
 * @param {QueryPaths} paths
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @param {{ write: (s: string) => void }} stdout
 * @param {{ write: (s: string) => void }} stderr
 * @param {QueryDataset[]} datasets
 * @param {string} sql
 * @returns {Promise<number>}
 */
async function executeGeneratedSql(paths, parsed, stdout, stderr, datasets, sql) {
  const prepared = prepareReadOnlySql(sql, parsed.limit)
  return executePrepared(paths, parsed, stdout, stderr, datasets, prepared.statement)
}

/**
 * @param {QueryPaths} paths
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @param {{ write: (s: string) => void }} stdout
 * @param {{ write: (s: string) => void }} stderr
 * @param {QueryDataset[]} datasets
 * @param {import('squirreling').Statement} statement
 * @returns {Promise<number>}
 */
async function executePrepared(paths, parsed, stdout, stderr, datasets, statement) {
  const scope = { ...baseScope(parsed), datasets }
  const ready = await ensureCacheReady(paths, scope, parsed)
  if (ready.ok === false) {
    stderr.write(ready.message + '\n')
    return 1
  }
  if (ready.warnings) {
    for (const warning of ready.warnings) stderr.write(warning + '\n')
  }
  const result = await executeLogicalSql({ paths, scope, datasets, statement })
  stdout.write(renderResult(result, parsed.format))
  return 0
}

/**
 * @param {QueryPaths} paths
 * @param {QueryScope} scope
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @returns {Promise<{ ok: true, warnings?: string[] } | { ok: false, message: string }>}
 */
async function ensureCacheReady(paths, scope, parsed) {
  if (!paths.parquetEnabled || !paths.parquetDir) {
    return { ok: false, message: 'error: query parquet cache is disabled; pass --parquet-dir or set query.parquet.enabled: true' }
  }
  if (parsed.refresh === 'always') {
    const result = await refreshQueryCache({ paths, scope, force: false })
    if (result.failures > 0) {
      return { ok: false, message: `error: refresh failed for ${result.failures} partition(s)` }
    }
  }
  const states = inspectCachePartitions(expectedCachePartitions(paths, scope))
  const missing = states.filter((state) => state.status === 'missing')
  const stale = states.filter((state) => state.status === 'stale')

  if (missing.length > 0) {
    const first = missing[0]
    const detail = `${first.partition.dataset}/${first.partition.gatewayId}/${first.partition.date}: missing${first.reason ? ` (${first.reason})` : ''}`
    return {
      ok: false,
      message: `error: query cache is missing for ${detail}. Run: ${refreshCommand(parsed)}`,
    }
  }

  if (stale.length > 0) {
    if (parsed.strictFreshness) {
      const first = stale[0]
      const detail = `${first.partition.dataset}/${first.partition.gatewayId}/${first.partition.date}: stale${first.reason ? ` (${first.reason})` : ''}`
      return {
        ok: false,
        message: `error: query cache is stale for ${detail} (--strict-freshness set). Run: ${refreshCommand(parsed)}`,
      }
    }
    const summary = stale.slice(0, 3).map((state) => `${state.partition.dataset}/${state.partition.gatewayId}/${state.partition.date}${state.reason ? ` (${state.reason})` : ''}`).join(', ')
    const more = stale.length > 3 ? `, +${stale.length - 3} more` : ''
    return {
      ok: true,
      warnings: [`warning: querying stale data; ${stale.length} partition(s) outdated [${summary}${more}] — run '${refreshCommand(parsed)}' to update`],
    }
  }

  return { ok: true }
}

/**
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @returns {string}
 */
function refreshCommand(parsed) {
  const parts = ['ctvs', 'query', 'refresh']
  if (parsed.configPath) parts.push('--config', shellQuote(parsed.configPath))
  if (parsed.parquetDir) parts.push('--parquet-dir', shellQuote(parsed.parquetDir))
  if (parsed.gatewayId) parts.push('--gateway-id', shellQuote(parsed.gatewayId))
  if (parsed.date) parts.push('--date', parsed.date)
  return parts.join(' ')
}

/**
 * @param {QueryPaths} paths
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @param {{ write: (s: string) => void }} stdout
 * @param {QueryDataset} dataset
 * @returns {Promise<number>}
 */
async function renderLiveTail(paths, parsed, stdout, dataset) {
  const rows = await readLiveRows(paths, { ...baseScope(parsed), dataset })
  const selected = rows.slice(-parsed.limit)
  const columns = dataset === 'proxy_exchanges'
    ? ['gateway_id', 'date', 'tsStart', 'durationMs', 'upstream', 'responseStatus', 'requestPath', 'exchangeId', 'error']
    : ['gateway_id', 'date', 'timestamp', 'severityText', 'serviceName', 'body', 'traceId', 'spanId']
  stdout.write(renderResult({ columns, rows: selected }, parsed.format))
  return 0
}

/**
 * @param {QueryPaths} paths
 * @param {QueryScope} scope
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function readLiveRows(paths, scope) {
  const sources = discoverSourceFiles(paths.recordingRoot, scope)
  /** @type {Record<string, unknown>[]} */
  const rows = []
  for (const source of sources) {
    for await (const raw of readJsonlRows(source.jsonlPath)) {
      if (scope.dataset === 'proxy_exchanges') {
        if (raw.kind !== 'exchange') continue
        rows.push(logicalProxyExchange(raw, source.gatewayId, source.date))
      } else {
        rows.push({ ...raw, gateway_id: source.gatewayId, date: source.date })
      }
    }
  }
  return rows.filter((row) => liveRowMatchesScope(row, scope))
}

/**
 * @param {Record<string, unknown>} raw
 * @param {string} gatewayId
 * @param {string} date
 * @returns {Record<string, unknown>}
 */
function logicalProxyExchange(raw, gatewayId, date) {
  return {
    gateway_id: gatewayId,
    date,
    exchangeId: raw.exchange_id,
    tsStart: raw.ts_start,
    tsEnd: raw.ts_end,
    durationMs: raw.duration_ms,
    upstream: raw.upstream,
    requestMethod: readPath(raw, ['request', 'method']),
    requestPath: readPath(raw, ['request', 'path']),
    responseStatus: readPath(raw, ['response', 'status']),
    streamEventCount: raw.stream_event_count,
    error: raw.error,
  }
}

/**
 * @param {Record<string, unknown>} row
 * @param {QueryScope} scope
 * @returns {boolean}
 */
function liveRowMatchesScope(row, scope) {
  if (scope.gatewayId && row.gateway_id !== scope.gatewayId) return false
  if (scope.date && row.date !== scope.date) return false
  if (scope.service && row.serviceName !== scope.service) return false
  if (!scope.from && !scope.to) return true
  const raw = row.timestamp ?? row.observedTimestamp ?? row.tsStart
  if (raw === undefined || raw === null) return true
  const ms = Date.parse(String(raw))
  if (!Number.isFinite(ms)) return true
  if (scope.from && ms < Date.parse(scope.from)) return false
  if (scope.to && ms > Date.parse(scope.to)) return false
  return true
}

/**
 * @param {QueryPaths} paths
 * @param {QueryScope} scope
 * @returns {Record<string, unknown>[]}
 */
function statusRows(paths, scope) {
  const datasets = scope.datasets ?? (scope.dataset ? [scope.dataset] : QUERY_DATASETS)
  const rows = []
  for (const dataset of datasets) {
    const datasetScope = { ...scope, datasets: [dataset] }
    const sources = discoverSourceFiles(paths.recordingRoot, datasetScope)
    const states = paths.parquetEnabled && paths.parquetDir
      ? inspectCachePartitions(expectedCachePartitions(paths, datasetScope))
      : []
    rows.push({
      dataset,
      sources: sources.length,
      fresh: states.filter((state) => state.status === 'fresh').length,
      stale: states.filter((state) => state.status === 'stale').length,
      missing: states.filter((state) => state.status === 'missing').length,
      rows: states.reduce((sum, state) => sum + (state.meta?.row_count ?? 0), 0),
    })
  }
  return rows
}

/**
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @returns {QueryScope}
 */
function baseScope(parsed) {
  return {
    gatewayId: parsed.gatewayId,
    date: parsed.date,
    from: parsed.from,
    to: parsed.to,
    service: parsed.service,
    limit: parsed.limit,
  }
}

/**
 * @param {ReturnType<typeof parseQueryArgs>} parsed
 * @param {string | undefined} rawDataset
 * @returns {QueryScope}
 */
function scopeWithOptionalDataset(parsed, rawDataset) {
  const scope = baseScope(parsed)
  if (rawDataset) scope.dataset = assertQueryDataset(rawDataset)
  return scope
}

/**
 * @param {number} limit
 * @returns {string}
 */
function activitySql(limit) {
  return `
select 'log' as signal, timestamp as timestamp, gateway_id, serviceName, severityText as detail from logs
union all
select 'trace' as signal, startTimestamp as timestamp, gateway_id, serviceName, name as detail from traces
union all
select 'metric' as signal, timestamp as timestamp, gateway_id, serviceName, metricName as detail from metrics
union all
select 'proxy' as signal, tsStart as timestamp, gateway_id, upstream as serviceName, requestPath as detail from proxy_exchanges
order by timestamp desc
limit ${limit}`
}

/**
 * @param {number} limit
 * @returns {string}
 */
function serviceSql(limit) {
  return `
select 'log' as signal, timestamp as timestamp, gateway_id, serviceName, body as detail from logs
union all
select 'trace' as signal, startTimestamp as timestamp, gateway_id, serviceName, name as detail from traces
union all
select 'metric' as signal, timestamp as timestamp, gateway_id, serviceName, metricName as detail from metrics
order by timestamp desc
limit ${limit}`
}

/**
 * @param {number} limit
 * @returns {string}
 */
function errorsSql(limit) {
  return `
select 'log' as signal, timestamp as timestamp, gateway_id, serviceName, severityText as detail from logs where severityNumber >= 17
union all
select 'trace' as signal, startTimestamp as timestamp, gateway_id, serviceName, name as detail from traces where JSON_VALUE(status, '$.code') = 2
union all
select 'proxy' as signal, tsStart as timestamp, gateway_id, upstream as serviceName, error as detail from proxy_exchanges where responseStatus >= 500 or error is not null
order by timestamp desc
limit ${limit}`
}

/**
 * @param {string} value
 * @returns {string}
 */
function sqlString(value) {
  const quote = '\''
  return quote + value.replace(/'/g, quote + quote) + quote
}

/**
 * @param {string} value
 * @returns {string}
 */
function shellQuote(value) {
  if (/^[A-Za-z0-9_./:@+-]+$/.test(value)) return value
  const quote = '\''
  return quote + value.replace(/'/g, quote + '\\' + quote + quote) + quote
}

/**
 * @param {string} input
 * @returns {number | undefined}
 */
function parseDurationMs(input) {
  const match = /^(\d+)(ms|s|m|h|d|w)$/.exec(input)
  if (!match) return
  const value = Number.parseInt(match[1], 10)
  const unit = match[2]
  const factor = unit === 'ms' ? 1
    : unit === 's' ? 1000
      : unit === 'm' ? 60 * 1000
        : unit === 'h' ? 60 * 60 * 1000
          : unit === 'd' ? 24 * 60 * 60 * 1000
            : 7 * 24 * 60 * 60 * 1000
  return value * factor
}

/**
 * @param {Record<string, unknown>} row
 * @param {string[]} keys
 * @returns {unknown}
 */
function readPath(row, keys) {
  /** @type {unknown} */
  let cur = row
  for (const key of keys) {
    if (cur === null || typeof cur !== 'object') return undefined
    cur = Reflect.get(cur, key)
  }
  return cur
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}
