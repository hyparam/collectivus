import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * @import { FileHandle } from 'node:fs/promises'
 * @import { CodexAttachOptions, CodexAttachResult, CodexDetachOptions, CodexDetachResult, CodexIsAttachedOptions } from '../types.js'
 */

const PROVIDER_ID = 'collectivus'
const ROOT_BEGIN = '# BEGIN collectivus codex model_provider'
const ROOT_END = '# END collectivus codex model_provider'
const PROVIDER_BEGIN = '# BEGIN collectivus codex provider'
const PROVIDER_END = '# END collectivus codex provider'
const TOML_BASIC_MULTILINE_DELIMITER = '"""'
const TOML_LITERAL_MULTILINE_DELIMITER = '\'\'\''
const TOML_KEY_PART = String.raw`(?:"(?:\\.|[^"\\])*"|'[^']*'|[A-Za-z0-9_-]+)`
const TOML_DOTTED_KEY = String.raw`${TOML_KEY_PART}(?:\s*\.\s*${TOML_KEY_PART})*`
const TOML_TABLE_HEADER_RE = new RegExp(String.raw`^\s*\[\s*${TOML_DOTTED_KEY}\s*\]\s*(?:#.*)?$`)
const TOML_TABLE_ARRAY_HEADER_RE = new RegExp(String.raw`^\s*\[\[\s*${TOML_DOTTED_KEY}\s*\]\]\s*(?:#.*)?$`)

export class CodexSettingsError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, cause?: unknown }} [opts]
   */
  constructor(message, opts = {}) {
    super(message)
    this.name = 'CodexSettingsError'
    /** @type {string | undefined} */
    this.code = opts.code
    if (opts.cause !== undefined) {
      /** @type {unknown} */
      this.cause = opts.cause
    }
  }
}

/**
 * Default Codex config location: `$CODEX_HOME/config.toml` when CODEX_HOME
 * is set, otherwise `~/.codex/config.toml`.
 *
 * @returns {string}
 */
export function defaultConfigPath() {
  if (typeof process.env.CODEX_HOME === 'string' && process.env.CODEX_HOME.length > 0) {
    return path.join(process.env.CODEX_HOME, 'config.toml')
  }
  return path.join(os.homedir(), '.codex', 'config.toml')
}

/**
 * Route Codex through the local collectivus OpenAI-compatible proxy by adding
 * a managed `model_provider = "collectivus"` root setting plus provider table.
 *
 * @param {CodexAttachOptions} opts
 * @returns {Promise<CodexAttachResult>}
 */
export async function attach(opts) {
  const { port, version, configPath = defaultConfigPath() } = opts
  validatePort(port)
  validateVersion(version)

  const { content, mtimeMs } = await readConfig(configPath)
  const prepared = prepareAttach(content, port, version)
  await writeAtomic(configPath, prepared.content, mtimeMs)

  /** @type {CodexAttachResult} */
  const result = { changed: true }
  if (prepared.prevValue !== undefined) result.prevValue = prepared.prevValue
  return result
}

/**
 * Reverse a previous `attach`. No-op when config.toml is absent or has no
 * collectivus-managed Codex block. Restores the previous root model_provider
 * when attach recorded one and no user-edited root value has appeared.
 *
 * @param {CodexDetachOptions} [opts]
 * @returns {Promise<CodexDetachResult>}
 */
export async function detach(opts = {}) {
  const { configPath = defaultConfigPath() } = opts
  const { content, existed, mtimeMs } = await readConfig(configPath)
  if (!existed) return { changed: false }

  const lines = splitLines(content)
  const hadRoot = hasMarkedBlock(lines, ROOT_BEGIN, ROOT_END)
  const hadProvider = hasMarkedBlock(lines, PROVIDER_BEGIN, PROVIDER_END)
  if (!hadRoot && !hadProvider) return { changed: false }

  const previous = readPreviousModelProvider(lines)
  const removed = readManagedProviderBaseUrl(lines)

  let next = removeMarkedBlock(lines, ROOT_BEGIN, ROOT_END)
  next = removeMarkedBlock(next, PROVIDER_BEGIN, PROVIDER_END)
  next = removeProviderTable(next)

  /** @type {string | undefined} */
  let restoredValue
  /** @type {string | undefined} */
  let warning
  if (previous !== undefined) {
    const current = readRootModelProvider(next)
    if (current === undefined) {
      insertRootLines(next, [`model_provider = ${tomlString(previous)}`])
      restoredValue = previous
    } else if (current !== previous) {
      warning = `model_provider was changed externally; leaving ${current} in place`
    }
  }

  await writeAtomic(configPath, formatLines(next), mtimeMs)

  /** @type {CodexDetachResult} */
  const result = { changed: true }
  if (removed !== undefined) result.removed = removed
  if (restoredValue !== undefined) result.restoredValue = restoredValue
  if (warning !== undefined) result.warning = warning
  return result
}

/**
 * Return true when config.toml exists and carries the collectivus-managed
 * Codex model provider block.
 *
 * @param {CodexIsAttachedOptions} [opts]
 * @returns {Promise<boolean>}
 */
export async function isAttached(opts = {}) {
  const { configPath = defaultConfigPath() } = opts
  const { content, existed } = await readConfig(configPath)
  if (!existed) return false
  const lines = splitLines(content)
  return hasMarkedBlock(lines, ROOT_BEGIN, ROOT_END)
    && hasMarkedBlock(lines, PROVIDER_BEGIN, PROVIDER_END)
}

/**
 * @param {string} content
 * @param {number} port
 * @param {string} version
 * @returns {{ content: string, prevValue?: string }}
 */
function prepareAttach(content, port, version) {
  let lines = splitLines(content)
  const previousFromMarker = readPreviousModelProvider(lines)
  lines = removeMarkedBlock(lines, ROOT_BEGIN, ROOT_END)
  lines = removeMarkedBlock(lines, PROVIDER_BEGIN, PROVIDER_END)

  const root = removeRootModelProvider(lines)
  lines = root.lines
  lines = removeProviderTable(lines)

  const prevValue = root.prevValue ?? previousFromMarker
  const now = new Date().toISOString()
  const rootBlock = [
    ROOT_BEGIN,
    `# attached_at = ${tomlString(now)}`,
    `# version = ${tomlString(version)}`,
    `# port = ${port}`,
  ]
  if (prevValue !== undefined) {
    rootBlock.push(`# previous_model_provider = ${tomlString(prevValue)}`)
  }
  rootBlock.push(`model_provider = ${tomlString(PROVIDER_ID)}`, ROOT_END)
  insertRootLines(lines, rootBlock)

  const providerBlock = [
    PROVIDER_BEGIN,
    '[model_providers.collectivus]',
    `name = ${tomlString('Collectivus OpenAI Proxy')}`,
    `base_url = ${tomlString(`http://127.0.0.1:${port}/v1`)}`,
    'requires_openai_auth = true',
    'wire_api = "responses"',
    'supports_websockets = false',
    PROVIDER_END,
  ]
  if (lines.length > 0 && lines[lines.length - 1] !== '') lines.push('')
  lines.push(...providerBlock)

  /** @type {{ content: string, prevValue?: string }} */
  const result = { content: formatLines(lines) }
  if (prevValue !== undefined) result.prevValue = prevValue
  return result
}

/**
 * @param {string} configPath
 * @returns {Promise<{ content: string, existed: boolean, mtimeMs: number | undefined }>}
 */
async function readConfig(configPath) {
  /** @type {string} */
  let content
  try {
    content = await fs.readFile(configPath, 'utf8')
  } catch (err) {
    if (errCode(err) === 'ENOENT') {
      return { content: '', existed: false, mtimeMs: undefined }
    }
    throw new CodexSettingsError(`failed to read ${configPath}: ${errMsg(err)}`, { cause: err })
  }

  let stat
  try {
    stat = await fs.stat(configPath)
  } catch (err) {
    throw new CodexSettingsError(`failed to stat ${configPath}: ${errMsg(err)}`, { cause: err })
  }
  return { content, existed: true, mtimeMs: stat.mtimeMs }
}

/**
 * @param {string} filePath
 * @param {string} body
 * @param {number | undefined} expectedMtimeMs
 * @returns {Promise<void>}
 */
async function writeAtomic(filePath, body, expectedMtimeMs) {
  if (expectedMtimeMs !== undefined) {
    let current
    try {
      current = await fs.stat(filePath)
    } catch (err) {
      if (errCode(err) === 'ENOENT') {
        throw new CodexSettingsError(
          `${filePath} disappeared between read and write; retry`,
          { code: 'CONCURRENT_EDIT', cause: err }
        )
      }
      throw err
    }
    if (current.mtimeMs !== expectedMtimeMs) {
      throw new CodexSettingsError(
        `${filePath} changed on disk between read and write; retry`,
        { code: 'CONCURRENT_EDIT' }
      )
    }
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true })

  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`

  /** @type {FileHandle | undefined} */
  let handle
  try {
    handle = await fs.open(tmpPath, 'w', 0o600)
    await handle.writeFile(body, 'utf8')
    await handle.sync()
  } finally {
    if (handle) await handle.close()
  }

  try {
    await fs.rename(tmpPath, filePath)
  } catch (err) {
    await fs.rm(tmpPath, { force: true })
    throw err
  }
}

/**
 * @param {string} content
 * @returns {string[]}
 */
function splitLines(content) {
  const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  if (normalized === '') return []
  const lines = normalized.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines
}

/**
 * @param {string[]} lines
 * @returns {string}
 */
function formatLines(lines) {
  const out = []
  for (const line of lines) {
    if (line === '' && (out.length === 0 || out[out.length - 1] === '')) continue
    out.push(line)
  }
  while (out[out.length - 1] === '') out.pop()
  return out.length === 0 ? '' : `${out.join('\n')}\n`
}

/**
 * @param {string[]} lines
 * @param {string[]} insert
 * @returns {void}
 */
function insertRootLines(lines, insert) {
  let index = findFirstTableIndex(lines)
  if (index === lines.length) {
    while (index > 0 && lines[index - 1] === '') index--
  }
  lines.splice(index, 0, ...insert)
}

/**
 * @param {string[]} lines
 * @returns {{ lines: string[], prevValue?: string }}
 */
function removeRootModelProvider(lines) {
  const firstTable = findFirstTableIndex(lines)
  /** @type {string[]} */
  const next = []
  /** @type {string | undefined} */
  let prevValue
  /** @type {TomlMultilineStringDelimiter | undefined} */
  let multilineDelimiter

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (i < firstTable && multilineDelimiter !== undefined) {
      multilineDelimiter = closeMultilineString(line, multilineDelimiter)
      next.push(line)
      continue
    }
    if (i < firstTable && isRootModelProviderLine(line)) {
      if (prevValue === undefined) prevValue = parseAssignmentString(line)
      continue
    }
    next.push(line)
    if (i < firstTable) {
      multilineDelimiter = openMultilineString(line)
    }
  }

  /** @type {{ lines: string[], prevValue?: string }} */
  const result = { lines: next }
  if (prevValue !== undefined) result.prevValue = prevValue
  return result
}

/**
 * @param {string[]} lines
 * @returns {string | undefined}
 */
function readRootModelProvider(lines) {
  const firstTable = findFirstTableIndex(lines)
  /** @type {TomlMultilineStringDelimiter | undefined} */
  let multilineDelimiter
  for (let i = 0; i < firstTable; i++) {
    if (multilineDelimiter !== undefined) {
      multilineDelimiter = closeMultilineString(lines[i], multilineDelimiter)
      continue
    }
    const parsed = parseRootModelProvider(lines[i])
    if (parsed !== undefined) return parsed
    multilineDelimiter = openMultilineString(lines[i])
  }
  return undefined
}

/**
 * @param {string[]} lines
 * @returns {number}
 */
function findFirstTableIndex(lines) {
  return findNextTableIndex(lines, 0)
}

/**
 * @param {string[]} lines
 * @param {number} start
 * @returns {number}
 */
function findNextTableIndex(lines, start) {
  /** @type {TomlMultilineStringDelimiter | undefined} */
  let multilineDelimiter
  for (let i = start; i < lines.length; i++) {
    const line = lines[i]
    if (multilineDelimiter !== undefined) {
      multilineDelimiter = closeMultilineString(line, multilineDelimiter)
      continue
    }
    if (isTableHeader(line)) return i
    multilineDelimiter = openMultilineString(line)
  }
  return lines.length
}

/**
 * @param {string[]} lines
 * @returns {string[]}
 */
function removeProviderTable(lines) {
  /** @type {string[]} */
  const next = []
  for (let i = 0; i < lines.length; i++) {
    const tableIndex = findNextTableIndex(lines, i)
    if (tableIndex === lines.length) {
      next.push(...lines.slice(i))
      break
    }
    next.push(...lines.slice(i, tableIndex))
    if (isCollectivusProviderHeader(lines[tableIndex])) {
      i = findNextTableIndex(lines, tableIndex + 1) - 1
      continue
    }
    next.push(lines[tableIndex])
    i = tableIndex
  }
  return next
}

/**
 * @param {string[]} lines
 * @param {string} begin
 * @param {string} end
 * @returns {string[]}
 */
function removeMarkedBlock(lines, begin, end) {
  /** @type {string[]} */
  const next = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== begin) {
      next.push(lines[i])
      continue
    }
    let foundEnd = false
    for (i++; i < lines.length; i++) {
      if (lines[i].trim() === end) {
        foundEnd = true
        break
      }
    }
    if (!foundEnd) {
      throw new CodexSettingsError('unterminated collectivus-managed Codex config block', {
        code: 'MALFORMED_MARKER',
      })
    }
  }
  return next
}

/**
 * @param {string[]} lines
 * @param {string} begin
 * @param {string} end
 * @returns {boolean}
 */
function hasMarkedBlock(lines, begin, end) {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() !== begin) continue
    for (i++; i < lines.length; i++) {
      if (lines[i].trim() === end) return true
    }
    throw new CodexSettingsError('unterminated collectivus-managed Codex config block', {
      code: 'MALFORMED_MARKER',
    })
  }
  return false
}

/**
 * @param {string[]} lines
 * @returns {string | undefined}
 */
function readPreviousModelProvider(lines) {
  return readCommentedString(lines, ROOT_BEGIN, ROOT_END, 'previous_model_provider')
}

/**
 * @param {string[]} lines
 * @returns {string | undefined}
 */
function readManagedProviderBaseUrl(lines) {
  return readAssignmentInBlock(lines, PROVIDER_BEGIN, PROVIDER_END, 'base_url')
}

/**
 * @param {string[]} lines
 * @param {string} begin
 * @param {string} end
 * @param {string} key
 * @returns {string | undefined}
 */
function readCommentedString(lines, begin, end, key) {
  const re = new RegExp(`^#\\s*${escapeRegExp(key)}\\s*=\\s*(.+)$`)
  let inside = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === begin) {
      inside = true
      continue
    }
    if (inside && trimmed === end) return undefined
    if (!inside) continue
    const match = line.match(re)
    if (!match) continue
    return parseTomlString(match[1])
  }
  return undefined
}

/**
 * @param {string[]} lines
 * @param {string} begin
 * @param {string} end
 * @param {string} key
 * @returns {string | undefined}
 */
function readAssignmentInBlock(lines, begin, end, key) {
  let inside = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === begin) {
      inside = true
      continue
    }
    if (inside && trimmed === end) return undefined
    if (!inside || !new RegExp(`^\\s*${escapeRegExp(key)}\\s*=`).test(line)) continue
    return parseAssignmentString(line)
  }
  return undefined
}

/**
 * @param {string} line
 * @returns {string | undefined}
 */
function parseRootModelProvider(line) {
  if (!isRootModelProviderLine(line)) return undefined
  return parseAssignmentString(line)
}

/**
 * @param {string} line
 * @returns {boolean}
 */
function isRootModelProviderLine(line) {
  return /^\s*model_provider\s*=/.test(line)
}

/**
 * @param {string} line
 * @returns {string | undefined}
 */
function parseAssignmentString(line) {
  const index = line.indexOf('=')
  if (index === -1) return undefined
  return parseTomlString(line.slice(index + 1))
}

/**
 * @param {string} value
 * @returns {string | undefined}
 */
function parseTomlString(value) {
  const trimmed = value.trim()
  if (trimmed.startsWith('"')) {
    const match = trimmed.match(/^"(?:\\.|[^"\\])*"/)
    if (!match) return undefined
    try {
      return JSON.parse(match[0])
    } catch {
      return undefined
    }
  }
  if (trimmed.startsWith('\'')) {
    const match = trimmed.match(/^'([^']*)'/)
    return match ? match[1] : undefined
  }
  return undefined
}

/**
 * @param {string} value
 * @returns {string}
 */
function tomlString(value) {
  return JSON.stringify(value)
}

/**
 * @param {string} line
 * @returns {boolean}
 */
function isTableHeader(line) {
  return TOML_TABLE_HEADER_RE.test(line) || TOML_TABLE_ARRAY_HEADER_RE.test(line)
}

/**
 * @typedef {'"""' | "'''"} TomlMultilineStringDelimiter
 */

/**
 * @param {string} line
 * @returns {TomlMultilineStringDelimiter | undefined}
 */
function openMultilineString(line) {
  const trimmed = assignmentValue(line) ?? line.trimStart()
  if (trimmed.startsWith(TOML_BASIC_MULTILINE_DELIMITER)) {
    return hasClosingMultilineString(trimmed.slice(3), TOML_BASIC_MULTILINE_DELIMITER)
      ? undefined
      : TOML_BASIC_MULTILINE_DELIMITER
  }
  if (trimmed.startsWith(TOML_LITERAL_MULTILINE_DELIMITER)) {
    return hasClosingMultilineString(trimmed.slice(3), TOML_LITERAL_MULTILINE_DELIMITER)
      ? undefined
      : TOML_LITERAL_MULTILINE_DELIMITER
  }
  return undefined
}

/**
 * @param {string} line
 * @param {TomlMultilineStringDelimiter} delimiter
 * @returns {TomlMultilineStringDelimiter | undefined}
 */
function closeMultilineString(line, delimiter) {
  return hasClosingMultilineString(line, delimiter) ? undefined : delimiter
}

/**
 * @param {string} line
 * @returns {string | undefined}
 */
function assignmentValue(line) {
  if (/^\s*#/.test(line)) return undefined
  const index = line.indexOf('=')
  return index === -1 ? undefined : line.slice(index + 1).trimStart()
}

/**
 * @param {string} value
 * @param {TomlMultilineStringDelimiter} delimiter
 * @returns {boolean}
 */
function hasClosingMultilineString(value, delimiter) {
  if (delimiter === TOML_LITERAL_MULTILINE_DELIMITER) return value.includes(delimiter)
  for (let index = value.indexOf(delimiter); index !== -1; index = value.indexOf(delimiter, index + 1)) {
    if (!isEscaped(value, index)) return true
  }
  return false
}

/**
 * @param {string} value
 * @param {number} index
 * @returns {boolean}
 */
function isEscaped(value, index) {
  let backslashes = 0
  for (let i = index - 1; i >= 0 && value[i] === '\\'; i--) backslashes++
  return backslashes % 2 === 1
}

/**
 * @param {string} line
 * @returns {boolean}
 */
function isCollectivusProviderHeader(line) {
  return /^\s*\[\s*model_providers\.collectivus\s*\]\s*(?:#.*)?$/.test(line)
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * @param {unknown} port
 * @returns {asserts port is number}
 */
function validatePort(port) {
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CodexSettingsError(`invalid port: ${String(port)}`, { code: 'INVALID_PORT' })
  }
}

/**
 * @param {unknown} version
 * @returns {asserts version is string}
 */
function validateVersion(version) {
  if (typeof version !== 'string' || version.length === 0) {
    throw new CodexSettingsError('version must be a non-empty string', {
      code: 'INVALID_VERSION',
    })
  }
}

/**
 * @param {unknown} err
 * @returns {string | undefined}
 */
function errCode(err) {
  if (!err || typeof err !== 'object' || !('code' in err)) return undefined
  const code = Reflect.get(err, 'code')
  return typeof code === 'string' ? code : undefined
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function errMsg(err) {
  return err instanceof Error ? err.message : String(err)
}
