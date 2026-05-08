import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * @typedef {object} CollectivusMarker
 * @property {string} attached_at - ISO-8601 timestamp written when attach() ran.
 * @property {string} version - Version of the collectivus install that wrote this marker.
 * @property {number} port - Loopback port the proxy was listening on at attach time.
 */

/**
 * @typedef {object} AttachOptions
 * @property {number} port - TCP port (1..65535) the local proxy listens on.
 * @property {string} version - Non-empty version string recorded in the marker.
 * @property {string} [settingsPath] - Override the settings.json path (default: `~/.claude/settings.json`).
 */

/**
 * @typedef {object} AttachResult
 * @property {true} changed - Always true; attach always (re)writes the marker.
 * @property {string} [prevValue] - Previous value of `env.ANTHROPIC_BASE_URL`, if any.
 */

/**
 * @typedef {object} DetachOptions
 * @property {string} [settingsPath] - Override the settings.json path (default: `~/.claude/settings.json`).
 */

/**
 * @typedef {object} DetachResult
 * @property {boolean} changed - True if the file was modified, false when no marker was present.
 * @property {string} [removed] - The `ANTHROPIC_BASE_URL` value that was removed when it matched the marker port.
 * @property {string} [warning] - Set when `ANTHROPIC_BASE_URL` was overridden externally and was left in place.
 */

/**
 * @typedef {object} IsAttachedOptions
 * @property {string} [settingsPath] - Override the settings.json path (default: `~/.claude/settings.json`).
 */

/**
 * @typedef {object} ReadResult
 * @property {Record<string, unknown>} value - Parsed object (mutable).
 * @property {boolean} existed - Whether the file was on disk.
 * @property {number | null} mtimeMs - mtime captured at read time (null when the file did not exist).
 */

export class SettingsError extends Error {
  /**
   * @param {string} message
   * @param {{ code?: string, cause?: unknown }} [opts]
   */
  constructor(message, opts = {}) {
    super(message)
    this.name = 'SettingsError'
    /** @type {string | undefined} */
    this.code = opts.code
    if (opts.cause !== undefined) {
      /** @type {unknown} */
      this.cause = opts.cause
    }
  }
}

/**
 * Default settings.json location: `~/.claude/settings.json`.
 *
 * @returns {string}
 */
export function defaultSettingsPath() {
  return path.join(os.homedir(), '.claude', 'settings.json')
}

/**
 * Route Claude Code through the local collectivus proxy by writing a
 * `_collectivus` marker and `env.ANTHROPIC_BASE_URL` into settings.json.
 * Always overwrites the marker so timestamps stay current.
 *
 * @param {AttachOptions} opts
 * @returns {Promise<AttachResult>}
 */
export async function attach(opts) {
  const { port, version, settingsPath = defaultSettingsPath() } = opts
  validatePort(port)
  validateVersion(version)

  const { value, mtimeMs } = await readSettings(settingsPath)

  const env = ensureObject(value, 'env')
  const previous = env.ANTHROPIC_BASE_URL
  const prevValue = typeof previous === 'string' ? previous : undefined

  env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${port}`
  value._collectivus = {
    attached_at: new Date().toISOString(),
    version,
    port,
  }

  await writeAtomic(settingsPath, value, mtimeMs)

  /** @type {AttachResult} */
  const result = { changed: true }
  if (prevValue !== undefined) result.prevValue = prevValue
  return result
}

/**
 * Reverse a previous `attach`. No-op when settings.json is absent or has no
 * `_collectivus` marker. Removes `env.ANTHROPIC_BASE_URL` only when it still
 * matches the recorded port; otherwise leaves it and surfaces a warning.
 *
 * @param {DetachOptions} [opts]
 * @returns {Promise<DetachResult>}
 */
export async function detach(opts = {}) {
  const { settingsPath = defaultSettingsPath() } = opts
  const { value, existed, mtimeMs } = await readSettings(settingsPath)

  if (!existed) return { changed: false }

  const marker = value._collectivus
  if (!isPlainObject(marker)) return { changed: false }

  const markerPort = typeof marker.port === 'number' ? marker.port : null
  delete value._collectivus

  /** @type {string | undefined} */
  let removed
  /** @type {string | undefined} */
  let warning
  if (isPlainObject(value.env)) {
    const { env } = value
    const current = env.ANTHROPIC_BASE_URL
    if (markerPort !== null && current === `http://127.0.0.1:${markerPort}`) {
      removed = current
      delete env.ANTHROPIC_BASE_URL
    } else if (typeof current === 'string') {
      warning = 'ANTHROPIC_BASE_URL was overridden externally; leaving in place'
    }
    if (Object.keys(env).length === 0) delete value.env
  }

  await writeAtomic(settingsPath, value, mtimeMs)

  /** @type {DetachResult} */
  const result = { changed: true }
  if (removed !== undefined) result.removed = removed
  if (warning !== undefined) result.warning = warning
  return result
}

/**
 * Return true when settings.json exists and carries a `_collectivus` marker.
 * Throws on a malformed file so callers see real problems instead of a
 * silent "not attached".
 *
 * @param {IsAttachedOptions} [opts]
 * @returns {Promise<boolean>}
 */
export async function isAttached(opts = {}) {
  const { settingsPath = defaultSettingsPath() } = opts
  const { value, existed } = await readSettings(settingsPath)
  if (!existed) return false
  return isPlainObject(value._collectivus)
}

/**
 * Read and parse settings.json. Returns an empty object when the file is
 * missing so attach() can create a fresh one. Throws SettingsError for any
 * other failure (malformed JSON, JSONC, non-object root, IO error).
 *
 * @param {string} settingsPath
 * @returns {Promise<ReadResult>}
 */
async function readSettings(settingsPath) {
  /** @type {string} */
  let raw
  try {
    raw = await fs.readFile(settingsPath, 'utf8')
  } catch (err) {
    if (errCode(err) === 'ENOENT') {
      return { value: {}, existed: false, mtimeMs: null }
    }
    throw new SettingsError(`failed to read ${settingsPath}: ${errMsg(err)}`, { cause: err })
  }

  let stat
  try {
    stat = await fs.stat(settingsPath)
  } catch (err) {
    throw new SettingsError(`failed to stat ${settingsPath}: ${errMsg(err)}`, { cause: err })
  }

  /** @type {unknown} */
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    if (looksLikeJsonc(raw)) {
      throw new SettingsError(
        `${settingsPath} appears to be JSONC; refuse to modify`,
        { code: 'JSONC', cause: err }
      )
    }
    throw new SettingsError(`malformed JSON in ${settingsPath}: ${errMsg(err)}`, {
      code: 'MALFORMED_JSON',
      cause: err,
    })
  }

  if (!isPlainObject(parsed)) {
    throw new SettingsError(
      `${settingsPath} must contain a JSON object at the root`,
      { code: 'NOT_AN_OBJECT' }
    )
  }

  return { value: parsed, existed: true, mtimeMs: stat.mtimeMs }
}

/**
 * Write `value` as pretty JSON to `filePath` atomically. If `expectedMtimeMs`
 * is non-null, refuses to overwrite when the file's mtime has moved since the
 * read (best-effort concurrent-edit detection). Cleans up the tmp file on
 * rename failure.
 *
 * @param {string} filePath
 * @param {unknown} value
 * @param {number | null} expectedMtimeMs
 * @returns {Promise<void>}
 */
async function writeAtomic(filePath, value, expectedMtimeMs) {
  if (expectedMtimeMs !== null) {
    let current
    try {
      current = await fs.stat(filePath)
    } catch (err) {
      if (errCode(err) === 'ENOENT') {
        throw new SettingsError(
          `${filePath} disappeared between read and write; retry`,
          { code: 'CONCURRENT_EDIT', cause: err }
        )
      }
      throw err
    }
    if (current.mtimeMs !== expectedMtimeMs) {
      throw new SettingsError(
        `${filePath} changed on disk between read and write; retry`,
        { code: 'CONCURRENT_EDIT' }
      )
    }
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true })

  const body = JSON.stringify(value, null, 2) + '\n'
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`

  /** @type {import('node:fs/promises').FileHandle | null} */
  let handle = null
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
 * Return `value[key]` when it's a plain object, otherwise replace it with a
 * fresh empty object. Used to prepare nested keys for mutation without
 * preserving non-object values that callers can't safely merge into.
 *
 * @param {Record<string, unknown>} value
 * @param {string} key
 * @returns {Record<string, unknown>}
 */
function ensureObject(value, key) {
  const existing = value[key]
  if (isPlainObject(existing)) return existing
  /** @type {Record<string, unknown>} */
  const fresh = {}
  value[key] = fresh
  return fresh
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Best-effort detection of `//` or `/* ... *\/` comments outside string
 * literals. Used as a hint when JSON.parse fails so callers see "JSONC"
 * instead of a generic "Unexpected token /" message.
 *
 * @param {string} content
 * @returns {boolean}
 */
function looksLikeJsonc(content) {
  let inString = false
  for (let i = 0; i < content.length; i++) {
    const c = content[i]
    if (inString) {
      if (c === '\\' && i + 1 < content.length) {
        i++
        continue
      }
      if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      inString = true
      continue
    }
    if (c === '/' && i + 1 < content.length) {
      const next = content[i + 1]
      if (next === '/' || next === '*') return true
    }
  }
  return false
}

/**
 * @param {unknown} port
 * @returns {asserts port is number}
 */
function validatePort(port) {
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SettingsError(`invalid port: ${String(port)}`, { code: 'INVALID_PORT' })
  }
}

/**
 * @param {unknown} version
 * @returns {asserts version is string}
 */
function validateVersion(version) {
  if (typeof version !== 'string' || version.length === 0) {
    throw new SettingsError('version must be a non-empty string', {
      code: 'INVALID_VERSION',
    })
  }
}

/**
 * @param {unknown} err
 * @returns {string | null}
 */
function errCode(err) {
  if (!err || typeof err !== 'object' || !('code' in err)) return null
  const { code } = /** @type {{ code: unknown }} */ (err)
  return typeof code === 'string' ? code : null
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function errMsg(err) {
  return err instanceof Error ? err.message : String(err)
}
