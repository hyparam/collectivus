import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { ConfigError, loadConfigAsync as defaultLoadConfig } from '../config.js'
import { rowsToParquet } from '../upload/parquet.js'
import { readJsonlRows } from '../upload/reader.js'
import { proxyRowsToParquet } from './proxy-parquet.js'

/**
 * @import { CollectivusConfig } from '../types.js'
 * @import { ExportFileResult, ExportHooks, ExportJob, ExportParseResult, ProxyExportResult } from './types.d.ts'
 * @import { Signal } from '../upload/upload.d.ts'
 */

const USAGE = `Usage:
  collectivus export --config <path|url> [--out <dir>] [--date <YYYY-MM-DD>] [--service <name>] [--signal <s>]

Convert recorded JSONL under the configured sink dir into local Parquet files.
Runs once and exits. Does not invoke the daily upload pipeline.

Drains both:
  - <id>/proxy/<date>.jsonl              → <out>/proxy/exchanges.parquet
                                           <out>/proxy/stream_events.parquet
  - services/<svc>/<signal>-<date>.jsonl → <out>/<svc>/<signal>/date=<date>/data.parquet

Options:
  --config <path|url> Path or http(s) URL to the collectivus JSON config (required)
  --out <dir>         Output directory (default: <sink.dir>/parquet)
  --date <date>       Only export this UTC date (YYYY-MM-DD; default: all). OTLP only.
  --service <name>    Only export this service (default: all). OTLP only.
  --signal <s>        Only export this signal: logs, traces, metrics (default: all). OTLP only.
  --help, -h          Show this help`

const FILE_PATTERN = /^(logs|traces|metrics)-(\d{4}-\d{2}-\d{2})\.jsonl$/
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
/** @type {ReadonlyArray<Signal>} */
const VALID_SIGNALS = ['logs', 'traces', 'metrics']

/**
 * Parse the argument list of `collectivus export`.
 *
 * @param {string[]} argv
 * @returns {ExportParseResult}
 */
export function parseExportArgs(argv) {
  /** @type {ExportParseResult} */
  const r = { help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') { r.help = true; return r }
    if (arg === '--config' || arg.startsWith('--config=')) {
      const value = arg === '--config' ? argv[++i] : arg.slice('--config='.length)
      if (!value) { r.error = '--config requires a path'; return r }
      r.configPath = value
      continue
    }
    if (arg === '--out' || arg.startsWith('--out=')) {
      const value = arg === '--out' ? argv[++i] : arg.slice('--out='.length)
      if (!value) { r.error = '--out requires a directory'; return r }
      r.outDir = value
      continue
    }
    if (arg === '--date' || arg.startsWith('--date=')) {
      const value = arg === '--date' ? argv[++i] : arg.slice('--date='.length)
      if (!value) { r.error = '--date requires YYYY-MM-DD'; return r }
      if (!DATE_PATTERN.test(value)) { r.error = `--date must be YYYY-MM-DD, got ${value}`; return r }
      r.date = value
      continue
    }
    if (arg === '--service' || arg.startsWith('--service=')) {
      const value = arg === '--service' ? argv[++i] : arg.slice('--service='.length)
      if (!value) { r.error = '--service requires a name'; return r }
      r.service = value
      continue
    }
    if (arg === '--signal' || arg.startsWith('--signal=')) {
      const value = arg === '--signal' ? argv[++i] : arg.slice('--signal='.length)
      if (!value) { r.error = '--signal requires logs|traces|metrics'; return r }
      if (!isSignal(value)) {
        r.error = `--signal must be logs, traces, or metrics; got ${value}`
        return r
      }
      r.signal = value
      continue
    }
    r.error = `unknown argument: ${arg}`
    return r
  }
  return r
}

/**
 * Run `collectivus export`. Walks `<sink.dir>/services/<svc>/<signal>-<date>.jsonl`
 * and writes one Parquet file per (service, signal, date) into `<outDir>`.
 *
 * Output layout matches the upload object key shape so the same partition
 * layout works with engines that infer partitions from path segments:
 *   `<outDir>/<service>/<signal>/date=<YYYY-MM-DD>/data.parquet`
 *
 * @param {string[]} argv
 * @param {ExportHooks} [hooks]
 * @returns {Promise<number>}
 */
export async function runExport(argv, hooks = {}) {
  const stdout = hooks.stdout ?? process.stdout
  const stderr = hooks.stderr ?? process.stderr
  const loadConfigFn = hooks.loadConfig ?? defaultLoadConfig

  const parsed = parseExportArgs(argv)
  if (parsed.help) {
    stdout.write(USAGE + '\n')
    return 0
  }
  if (parsed.error) {
    stderr.write(`error: ${parsed.error}\n\n${USAGE}\n`)
    return 2
  }
  if (!parsed.configPath) {
    stderr.write(`error: --config is required\n\n${USAGE}\n`)
    return 2
  }

  /** @type {CollectivusConfig} */
  let config
  try {
    config = await loadConfigFn(parsed.configPath)
  } catch (err) {
    if (err instanceof ConfigError) {
      stderr.write(`config error: ${err.message}\n`)
      return 1
    }
    throw err
  }

  if (!config.sink) {
    stderr.write('error: config has no sink; nothing to export\n')
    return 1
  }

  const sinkDir = config.sink.dir
  const outDir = parsed.outDir ?? path.join(sinkDir, 'parquet')

  let written = 0
  let totalRows = 0
  let failures = 0

  const proxyJsonlFiles = discoverProxyJsonlFiles(sinkDir)
  if (proxyJsonlFiles.length > 0) {
    try {
      const result = await exportProxy(proxyJsonlFiles, outDir)
      for (const file of result.files) {
        written++
        totalRows += file.rows
        stdout.write(`wrote ${file.outPath} (${file.rows} rows, ${file.bytes} bytes)\n`)
      }
      if (result.skipped.length > 0) {
        for (const kind of result.skipped) {
          stdout.write(`skip proxy/${kind}: 0 rows\n`)
        }
      }
    } catch (err) {
      failures++
      stderr.write(`error: <id>/proxy/*.jsonl: ${formatError(err)}\n`)
    }
  }

  const jobs = discoverExportJobs(sinkDir, {
    date: parsed.date,
    service: parsed.service,
    signal: parsed.signal,
  })

  for (const job of jobs) {
    try {
      const result = await exportOne(job, outDir)
      if (result.rows === 0) {
        stdout.write(`skip ${job.service}/${job.signal}/${job.date}: 0 rows\n`)
        continue
      }
      written++
      totalRows += result.rows
      stdout.write(`wrote ${result.outPath} (${result.rows} rows, ${result.bytes} bytes)\n`)
    } catch (err) {
      failures++
      stderr.write(`error: ${job.service}/${job.signal}/${job.date}: ${formatError(err)}\n`)
    }
  }

  if (written === 0 && failures === 0) {
    stdout.write(`No JSONL files matched in ${sinkDir}.\n`)
    return 0
  }

  stdout.write(`Done. ${written} file(s), ${totalRows} row(s)${failures ? `, ${failures} failure(s)` : ''}.\n`)
  return failures === 0 ? 0 : 1
}

/**
 * Discover every per-day proxy JSONL file under `<sinkDir>/<id>/proxy/`.
 * Sorted by full path so multi-id, multi-day fixtures land in stable order.
 *
 * @param {string} sinkDir
 * @returns {string[]}
 */
export function discoverProxyJsonlFiles(sinkDir) {
  /** @type {string[]} */
  const out = []
  for (const id of safeReadDir(sinkDir)) {
    const proxyDir = path.join(sinkDir, id, 'proxy')
    let stat
    try {
      stat = fs.statSync(proxyDir)
    } catch {
      continue
    }
    if (!stat.isDirectory()) continue
    for (const name of safeReadDir(proxyDir)) {
      if (!name.endsWith('.jsonl')) continue
      out.push(path.join(proxyDir, name))
    }
  }
  out.sort()
  return out
}

/**
 * Read every per-day proxy JSONL file in `jsonlPaths`, partition rows by
 * `kind`, and write one parquet file per non-empty kind. Reads each file
 * fully into memory: proxy JSONL is append-only and typically modest;
 * streaming directly into a writer would only matter at multi-GB scale.
 *
 * @param {string[]} jsonlPaths
 * @param {string} outDir
 * @returns {Promise<ProxyExportResult>}
 */
export async function exportProxy(jsonlPaths, outDir) {
  /** @type {Record<string, unknown>[]} */
  const exchanges = []
  /** @type {Record<string, unknown>[]} */
  const streamEvents = []
  for (const jsonlPath of jsonlPaths) {
    for await (const row of readJsonlRows(jsonlPath)) {
      if (row.kind === 'exchange') exchanges.push(row)
      else if (row.kind === 'stream_event') streamEvents.push(row)
    }
  }

  const proxyDir = path.join(outDir, 'proxy')
  /** @type {ExportFileResult[]} */
  const files = []
  /** @type {Array<'exchange' | 'stream_event'>} */
  const skipped = []

  /** @type {Array<['exchange' | 'stream_event', Record<string, unknown>[], string]>} */
  const proxyKinds = [
    ['exchange', exchanges, 'exchanges.parquet'],
    ['stream_event', streamEvents, 'stream_events.parquet'],
  ]

  for (const [kind, rows, fileName] of proxyKinds) {
    if (rows.length === 0) {
      skipped.push(kind)
      continue
    }
    const buf = await proxyRowsToParquet(kind, rows)
    if (!buf) {
      skipped.push(kind)
      continue
    }
    fs.mkdirSync(proxyDir, { recursive: true })
    const outPath = path.join(proxyDir, fileName)
    fs.writeFileSync(outPath, buf)
    files.push({ rows: rows.length, bytes: buf.byteLength, outPath })
  }

  return { files, skipped }
}

/**
 * @param {string} sinkDir
 * @param {{ date?: string, service?: string, signal?: Signal }} filter
 * @returns {ExportJob[]}
 */
export function discoverExportJobs(sinkDir, filter) {
  const servicesDir = path.join(sinkDir, 'services')
  if (!fs.existsSync(servicesDir)) return []

  /** @type {ExportJob[]} */
  const jobs = []
  const services = filter.service ? [filter.service] : safeReadDir(servicesDir)
  for (const service of services) {
    const serviceDir = path.join(servicesDir, service)
    const entries = safeReadDir(serviceDir)
    for (const entry of entries) {
      const match = FILE_PATTERN.exec(entry)
      if (!match) continue
      const signal = match[1]
      if (!isSignal(signal)) continue
      const date = match[2]
      if (filter.signal && signal !== filter.signal) continue
      if (filter.date && date !== filter.date) continue
      jobs.push({ service, signal, date, jsonlPath: path.join(serviceDir, entry) })
    }
  }
  jobs.sort(compareJobs)
  return jobs
}

/**
 * @param {ExportJob} job
 * @param {string} outDir
 * @returns {Promise<{ rows: number, bytes: number, outPath: string }>}
 */
async function exportOne(job, outDir) {
  /** @type {Record<string, unknown>[]} */
  const rows = []
  for await (const row of readJsonlRows(job.jsonlPath)) {
    rows.push(row)
  }
  const partitionDir = path.join(outDir, job.service, job.signal, `date=${job.date}`)
  const outPath = path.join(partitionDir, 'data.parquet')
  if (rows.length === 0) {
    return { rows: 0, bytes: 0, outPath }
  }
  const buf = await rowsToParquet(job.signal, rows)
  fs.mkdirSync(partitionDir, { recursive: true })
  fs.writeFileSync(outPath, buf)
  return { rows: rows.length, bytes: buf.byteLength, outPath }
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function safeReadDir(dir) {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * @param {ExportJob} a
 * @param {ExportJob} b
 * @returns {number}
 */
function compareJobs(a, b) {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1
  if (a.service !== b.service) return a.service < b.service ? -1 : 1
  return VALID_SIGNALS.indexOf(a.signal) - VALID_SIGNALS.indexOf(b.signal)
}

/**
 * @param {string} value
 * @returns {value is Signal}
 */
function isSignal(value) {
  return value === 'logs' || value === 'traces' || value === 'metrics'
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}
