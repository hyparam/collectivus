import process from 'node:process'
import { ConfigError, loadConfigAsync as defaultLoadConfig } from '../config.js'
import { defaultConfigPath } from './common.js'
import { renderResult } from '../query/format.js'
import { resolveQueryPaths } from '../query/paths.js'
import {
  listCollections,
  normalizeTableName,
  refreshCollectionCache,
  registerCollection,
  removeCollection,
} from '../query/collections.js'

/**
 * @import { CollectivusConfig } from '../types.js'
 * @import { CollectHooks, CollectParseResult } from './types.d.ts'
 * @import { QueryFormat } from '../query/types.js'
 */

const USAGE = `Usage:
  ctvs collect <file.jsonl> --name <name> [--replace] [--timestamp-column <field>]
  ctvs collect list
  ctvs collect remove <name-or-table>

Register external JSONL files as dynamic tables for \`ctvs query sql\`.

Options:
  --config <path|url>            Config path or URL (default: ~/.hyp/collectivus.json)
  --parquet-dir <dir>            Query-cache directory
  --name <name>                  User-facing collection name; normalized to a SQL table name
  --replace                      Replace an existing collection with the same normalized table name
  --timestamp-column <field>     Source field used for --from/--to/--since filtering
  --format <fmt>                 table, json, jsonl, markdown (list only)
  --help, -h                     Show this help`

/**
 * @param {string[]} argv
 * @returns {CollectParseResult}
 */
export function parseCollectArgs(argv) {
  /** @type {{ kind: 'add' | 'list' | 'remove', configPath: string, parquetDir?: string, filePath?: string, name?: string, nameOrTable?: string, replace: boolean, timestampColumn?: string, format: QueryFormat }} */
  const out = {
    kind: 'add',
    configPath: defaultConfigPath(),
    replace: false,
    format: /** @type {QueryFormat} */ ('table'),
  }
  if (argv.length === 0) return { kind: 'help' }

  const first = argv[0]
  if (first === '--help' || first === '-h') return { kind: 'help' }
  if (first === 'list') {
    out.kind = 'list'
    argv = argv.slice(1)
  } else if (first === 'remove') {
    out.kind = 'remove'
    argv = argv.slice(1)
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { kind: 'help' }
    if (arg === '--replace') {
      out.replace = true
      continue
    }
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
      if (!configPath) return { kind: 'error', message: '--config requires a path or URL', exitCode: 2 }
      out.configPath = configPath
      continue
    }
    const parquetDir = readValue('--parquet-dir')
    if (parquetDir !== undefined) {
      if (!parquetDir) return { kind: 'error', message: '--parquet-dir requires a directory', exitCode: 2 }
      out.parquetDir = parquetDir
      continue
    }
    const name = readValue('--name')
    if (name !== undefined) {
      if (!name) return { kind: 'error', message: '--name requires a value', exitCode: 2 }
      out.name = name
      continue
    }
    const timestampColumn = readValue('--timestamp-column')
    if (timestampColumn !== undefined) {
      if (!timestampColumn) return { kind: 'error', message: '--timestamp-column requires a field name', exitCode: 2 }
      out.timestampColumn = timestampColumn
      continue
    }
    const format = readValue('--format')
    if (format !== undefined) {
      if (!isQueryFormat(format)) return { kind: 'error', message: '--format must be table, json, jsonl, or markdown', exitCode: 2 }
      out.format = format
      continue
    }
    if (arg.startsWith('--')) return { kind: 'error', message: `unknown argument: ${arg}`, exitCode: 2 }
    if (out.kind === 'add') {
      if (out.filePath) return { kind: 'error', message: `unexpected argument: ${arg}`, exitCode: 2 }
      out.filePath = arg
    } else if (out.kind === 'remove') {
      if (out.nameOrTable) return { kind: 'error', message: `unexpected argument: ${arg}`, exitCode: 2 }
      out.nameOrTable = arg
    } else {
      return { kind: 'error', message: `unexpected argument: ${arg}`, exitCode: 2 }
    }
  }

  if (out.kind === 'add') {
    if (!out.filePath) return { kind: 'error', message: 'JSONL file path is required', exitCode: 2 }
    if (!out.name) return { kind: 'error', message: '--name is required', exitCode: 2 }
  }
  if (out.kind === 'remove' && !out.nameOrTable) {
    return { kind: 'error', message: 'remove requires a collection name or table', exitCode: 2 }
  }
  return /** @type {CollectParseResult} */ (out)
}

/**
 * @param {string[]} argv
 * @param {CollectHooks} [hooks]
 * @returns {Promise<number>}
 */
export async function runCollect(argv, hooks = {}) {
  const stdout = hooks.stdout ?? process.stdout
  const stderr = hooks.stderr ?? process.stderr
  const parsed = parseCollectArgs(argv)
  if (parsed.kind === 'help') {
    stdout.write(USAGE + '\n')
    return 0
  }
  if (parsed.kind === 'error') {
    stderr.write(`error: ${parsed.message}\n\n${USAGE}\n`)
    return parsed.exitCode
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

  let paths
  try {
    paths = resolveQueryPaths(config, parsed.configPath, parsed.parquetDir)
  } catch (err) {
    stderr.write(`error: ${formatError(err)}\n`)
    return 1
  }

  try {
    switch (parsed.kind) {
    case 'list': {
      const rows = listCollections(paths.recordingRoot).map((collection) => ({
        name: collection.name,
        table: collection.table,
        source_path: collection.source_path,
        timestamp_column: collection.timestamp_column ?? '',
      }))
      stdout.write(renderResult({ columns: ['name', 'table', 'source_path', 'timestamp_column'], rows }, parsed.format))
      return 0
    }
    case 'remove': {
      const removed = removeCollection(paths.recordingRoot, parsed.nameOrTable)
      if (!removed) {
        stderr.write(`error: collection not found: ${parsed.nameOrTable}\n`)
        return 1
      }
      stdout.write(`Removed collection ${removed.table} (${removed.name})\n`)
      return 0
    }
    case 'add': {
      if (!paths.parquetEnabled || !paths.parquetDir) {
        stderr.write('error: query parquet cache is disabled; pass --parquet-dir to collect explicitly\n')
        return 1
      }
      const table = normalizeTableName(parsed.name)
      const collection = registerCollection({
        recordingRoot: paths.recordingRoot,
        filePath: parsed.filePath,
        name: parsed.name,
        timestampColumn: parsed.timestampColumn,
        replace: parsed.replace,
      })
      stdout.write(`Registered ${collection.name} as table ${collection.table}\n`)
      if (table !== parsed.name) stdout.write(`SQL table name: ${collection.table}\n`)
      const result = await refreshCollectionCache({
        paths,
        scope: { datasets: [collection.table], limit: 100 },
        force: true,
        stdout,
      })
      stdout.write(`Done. ${result.written} file(s) written, ${result.skipped} fresh, ${result.rows} row(s)${result.failures ? `, ${result.failures} failure(s)` : ''}.\n`)
      stdout.write(`Query with: ctvs query sql "select * from ${collection.table}"\n`)
      return result.failures === 0 ? 0 : 1
    }
    default: {
      /** @type {never} */
      const exhaustive = parsed
      throw new Error(`unhandled collect parse result: ${JSON.stringify(exhaustive)}`)
    }
    }
  } catch (err) {
    stderr.write(`error: ${formatError(err)}\n`)
    return 1
  }
}

/**
 * @param {unknown} value
 * @returns {value is QueryFormat}
 */
function isQueryFormat(value) {
  return value === 'table' || value === 'json' || value === 'jsonl' || value === 'markdown'
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}
