import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/**
 * @typedef {object} CollectivusMarker
 * @property {string} attached_at - ISO-8601 timestamp of the most recent attach.
 * @property {string} version - Version string of the collectivus install that wrote the marker.
 * @property {number} port - Loopback port the proxy was listening on at attach time.
 */

/**
 * @typedef {object} ParsedSettings
 * @property {Record<string, unknown> & { env?: Record<string, unknown>, _collectivus?: CollectivusMarker }} value - Decoded settings object.
 * @property {boolean} existed - Whether the settings file existed on disk.
 * @property {number | null} mtimeMs - mtime of the file when read, used for concurrent-edit detection.
 */

/**
 * @typedef {object} AttachOptions
 * @property {number} port - Loopback port the proxy is listening on.
 * @property {string} version - Version string to record in the marker.
 * @property {string} [settingsPath] - Override the settings.json path. Defaults to `~/.claude/settings.json`.
 */

/**
 * @typedef {object} AttachResult
 * @property {boolean} changed - Always `true` for `attach`; the marker is always (re)written.
 * @property {string} [prevValue] - Previous value of `env.ANTHROPIC_BASE_URL`, if one was set.
 */

/**
 * @typedef {object} DetachOptions
 * @property {string} [settingsPath] - Override the settings.json path. Defaults to `~/.claude/settings.json`.
 */

/**
 * @typedef {object} DetachResult
 * @property {boolean} changed - `true` if the file was modified, `false` if nothing was attached.
 * @property {string} [removed] - The `ANTHROPIC_BASE_URL` value that was removed, if it matched the recorded port.
 * @property {string} [warning] - Human-readable warning when state was unexpected (e.g., env was overridden externally).
 */

/**
 * @typedef {object} IsAttachedOptions
 * @property {string} [settingsPath] - Override the settings.json path. Defaults to `~/.claude/settings.json`.
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
 * @returns {string} Default settings path under the current user's home directory.
 */
export function defaultSettingsPath() {
  return path.join(os.homedir(), '.claude', 'settings.json')
}

/**
 * Add the collectivus proxy entry to Claude Code's settings.json.
 *
 * Idempotent at the level of "what gets written": always overwrites the
 * `ANTHROPIC_BASE_URL` env var and the `_collectivus` marker. The marker
 * timestamp moves on every call.
 *
 * @param {AttachOptions} opts
 * @returns {Promise<AttachResult>}
 */
export async function attach(opts) {
  const { port, version, settingsPath = defaultSettingsPath() } = opts
  validatePort(port)
  validateVersion(version)

  const { value, mtimeMs } = await readSettings(settingsPath, { allowMissing: true })

  const env = ensurePlainObject(value, 'env')
  const prevRaw = env.ANTHROPIC_BASE_URL
  const prevValue = typeof prevRaw === 'string' ? prevRaw : undefined

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
 * Remove the collectivus proxy entry from Claude Code's settings.json.
 *
 * No-op when the `_collectivus` marker is absent (or the file is missing).
 * If `env.ANTHROPIC_BASE_URL` was overridden externally to a value that no
 * longer matches the recorded port, the env var is left in place and a
 * warning is returned alongside `changed: true` (the marker is still cleared).
 *
 * @param {DetachOptions} [opts]
 * @returns {Promise<DetachResult>}
 */
export async function detach(opts = {}) {
  const { settingsPath = defaultSettingsPath() } = opts

  const settings = await readSettings(settingsPath, { allowMissing: true })
  if (!settings.existed) return { changed: false }

  const { value, mtimeMs } = settings
  const marker = value._collectivus
  if (!isPlainObject(marker)) return { changed: false }

  const markerPort = typeof marker.port === 'number' ? marker.port : null
  delete value._collectivus

  /** @type {string | undefined} */
  let removed
  /** @type {string | undefined} */
  let warning
  const env = isPlainObject(value.env) ? value.env : null
  if (env) {
    const current = env.ANTHROPIC_BASE_URL
    if (markerPort !== null && current === `http://127.0.0.1:${markerPort}`) {
      removed = current
      delete env.ANTHROPIC_BASE_URL
    } else if (typeof current === 'string') {
      warning =
        'ANTHROPIC_BASE_URL was overridden externally; leaving in place'
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
 * Report whether a `_collectivus` marker is present in settings.json.
 *
 * Returns `false` for a missing file. Throws for a malformed file so callers
 * know there's a real problem that should be surfaced rather than silently
 * reported as "not attached".
 *
 * @param {IsAttachedOptions} [opts]
 * @returns {Promise<boolean>}
 */
export async function isAttached(opts = {}) {
  const { settingsPath = defaultSettingsPath() } = opts
  const settings = await readSettings(settingsPath, { allowMissing: true })
  if (!settings.existed) return false
  return isPlainObject(settings.value._collectivus)
}

/**
 * @param {string} settingsPath
 * @param {{ allowMissing: boolean }} opts
 * @returns {Promise<ParsedSettings>}
 */
async function readSettings(settingsPath, opts) {
  /** @type {string} */
  let raw
  try {
    raw = await fs.readFile(settingsPath, 'utf8')
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : null
    if (code === 'ENOENT') {
      if (opts.allowMissing) {
        return { value: {}, existed: false, mtimeMs: null }
      }
      throw new SettingsError(`settings file not found: ${settingsPath}`, {
        code: 'ENOENT',
        cause: err,
      })
    }
    const msg = err instanceof Error ? err.message : String(err)
    throw new SettingsError(`failed to read ${settingsPath}: ${msg}`, { cause: err })
  }

  let stat
  try {
    stat = await fs.stat(settingsPath)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new SettingsError(`failed to stat ${settingsPath}: ${msg}`, { cause: err })
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
    const msg = err instanceof Error ? err.message : String(err)
    throw new SettingsError(`malformed JSON in ${settingsPath}: ${msg}`, {
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
 * Write `value` as pretty JSON to `filePath` atomically: writes to a temp
 * sibling file, fsyncs, then renames over the final path. Refuses to write
 * when the file's mtime has changed since `expectedMtimeMs` (best-effort
 * concurrent-edit detection — a determined writer can still race the rename,
 * but the typical "user opened editor, edited, saved" case is caught).
 *
 * Preserves the existing file's permissions when present; falls back to 0o600
 * when creating a new file, since the contents typically include private URLs
 * and tokens.
 *
 * @param {string} filePath
 * @param {unknown} value
 * @param {number | null} expectedMtimeMs - mtime captured at read time; null when the file did not exist.
 * @returns {Promise<void>}
 */
async function writeAtomic(filePath, value, expectedMtimeMs) {
  /** @type {number} */
  let mode = 0o600
  if (expectedMtimeMs !== null) {
    /** @type {import('node:fs').Stats} */
    let current
    try {
      current = await fs.stat(filePath)
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? err.code : null
      if (code === 'ENOENT') {
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
    mode = current.mode & 0o777
  }

  await fs.mkdir(path.dirname(filePath), { recursive: true })

  const body = JSON.stringify(value, null, 2) + '\n'
  const tmpPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`

  /** @type {import('node:fs/promises').FileHandle | null} */
  let handle = null
  try {
    handle = await fs.open(tmpPath, 'w', mode)
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
 * Treat `value[key]` as a plain object, creating it if absent. Used to
 * destructively prepare nested keys before mutating them.
 *
 * @param {Record<string, unknown>} value
 * @param {string} key
 * @returns {Record<string, unknown>}
 */
function ensurePlainObject(value, key) {
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
 * Best-effort detection of JSONC-style comments outside string literals.
 * Used as a hint when `JSON.parse` fails so we can produce a more helpful
 * error than "Unexpected token /".
 *
 * @param {string} content
 * @returns {boolean}
 */
function looksLikeJsonc(content) {
  let inString = false
  let i = 0
  while (i < content.length) {
    const c = content[i]
    if (inString) {
      if (c === '\\' && i + 1 < content.length) {
        i += 2
        continue
      }
      if (c === '"') inString = false
      i++
      continue
    }
    if (c === '"') {
      inString = true
      i++
      continue
    }
    if (c === '/' && i + 1 < content.length) {
      const next = content[i + 1]
      if (next === '/' || next === '*') return true
    }
    i++
  }
  return false
}

/**
 * @param {unknown} port
 * @returns {asserts port is number}
 */
function validatePort(port) {
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SettingsError(`invalid port: ${port}`, { code: 'INVALID_PORT' })
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
