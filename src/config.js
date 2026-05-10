import fs from 'node:fs'
import process from 'node:process'

/**
 * @import { CollectivusConfig } from './types.js'
 */

export class ConfigError extends Error {
  /**
   * @param {string} message
   * @param {{ pointer?: string }} [opts]
   */
  constructor(message, opts = {}) {
    const { pointer } = opts
    super(pointer ? `${pointer}: ${message}` : message)
    this.name = 'ConfigError'
    /** @type {string | undefined} */
    this.pointer = pointer
  }
}

const ALLOWED_TOP_KEYS = new Set(['version', 'otel', 'proxy', 'sink', 'upload'])
const ALLOWED_PROXY_KEYS = new Set(['listen', 'upstreams', 'redact_headers'])
const ALLOWED_UPSTREAM_KEYS = new Set(['name', 'base_url', 'match'])
const ALLOWED_SINK_KEYS = new Set(['type', 'dir'])
const ALLOWED_UPLOAD_KEYS = new Set([
  'bucket', 'prefix', 'region', 'time', 'signals', 'catchupDays', 'endpoint',
])
const ALLOWED_SIGNALS = new Set(['logs', 'traces', 'metrics'])
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/

/**
 * Returns true when `value` is a `http://` or `https://` URL that
 * `loadConfigAsync` should fetch instead of reading from disk.
 *
 * @param {string} value
 * @returns {boolean}
 */
export function isConfigUrl(value) {
  return /^https?:\/\//i.test(value)
}

/**
 * Load and validate a collectivus JSON config file.
 *
 * @param {string} configPath - Absolute or relative path to a JSON config file.
 * @param {{ strict?: boolean, stderr?: { write: (s: string) => void } }} [opts]
 *   `strict=true` rejects unknown top-level keys; the default warns to stderr
 *   and proceeds. Per-section unknown keys are always rejected.
 * @returns {CollectivusConfig} The parsed and validated config.
 * @throws {ConfigError} when the file is missing, JSON is invalid, or the schema check fails.
 */
export function loadConfig(configPath, opts = {}) {
  let raw
  try {
    raw = fs.readFileSync(configPath, 'utf8')
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined
    if (code === 'ENOENT') {
      throw new ConfigError(`config file not found: ${configPath}`)
    }
    const msg = err instanceof Error ? err.message : String(err)
    throw new ConfigError(`failed to read ${configPath}: ${msg}`)
  }

  return parseConfig(raw, configPath, opts)
}

/**
 * Load and validate a collectivus JSON config from either a local path or
 * an `http(s)://` URL. URLs are fetched with `globalThis.fetch`; non-URL
 * values fall through to the sync `loadConfig` reader.
 *
 * @param {string} pathOrUrl
 * @param {{ strict?: boolean, stderr?: { write: (s: string) => void }, fetch?: typeof fetch }} [opts]
 * @returns {Promise<CollectivusConfig>}
 * @throws {ConfigError} when the source is unreachable, the body is not JSON, or the schema check fails.
 */
export async function loadConfigAsync(pathOrUrl, opts = {}) {
  if (!isConfigUrl(pathOrUrl)) return loadConfig(pathOrUrl, opts)

  const fetchFn = opts.fetch ?? globalThis.fetch
  if (typeof fetchFn !== 'function') {
    throw new ConfigError(`fetch is not available; cannot load config from ${pathOrUrl}`)
  }

  let response
  try {
    response = await fetchFn(pathOrUrl)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new ConfigError(`failed to fetch ${pathOrUrl}: ${msg}`)
  }

  if (!response.ok) {
    throw new ConfigError(
      `failed to fetch ${pathOrUrl}: HTTP ${response.status} ${response.statusText}`
    )
  }

  let raw
  try {
    raw = await response.text()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new ConfigError(`failed to read response body from ${pathOrUrl}: ${msg}`)
  }

  return parseConfig(raw, pathOrUrl, opts)
}

/**
 * Parse a raw JSON config string and run schema validation. The `source`
 * argument is only used to render error locations.
 *
 * @param {string} raw
 * @param {string} source
 * @param {{ strict?: boolean, stderr?: { write: (s: string) => void } }} [opts]
 * @returns {CollectivusConfig}
 */
export function parseConfig(raw, source, opts = {}) {
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const location = jsonErrorLocation(raw, msg)
    throw new ConfigError(`invalid JSON in ${source}${location}: ${msg}`)
  }

  validateConfig(parsed, {
    strict: opts.strict ?? false,
    stderr: opts.stderr ?? process.stderr,
  })
  return parsed
}

/**
 * Extract `at line N, column M` from a `JSON.parse` error message.
 * V8 reports `position N`; older runtimes may report `line N column M`. If we
 * can't find an offset, return an empty string and leave the location off.
 *
 * @param {string} raw - The original JSON source.
 * @param {string} msg - The error message from JSON.parse.
 * @returns {string} A leading-space location string, or '' when not derivable.
 */
function jsonErrorLocation(raw, msg) {
  const posMatch = /position (\d+)/.exec(msg)
  if (posMatch) {
    const offset = Number.parseInt(posMatch[1], 10)
    const before = raw.slice(0, Math.min(offset, raw.length))
    const line = before.split('\n').length
    const lastNewline = before.lastIndexOf('\n')
    const column = lastNewline === -1 ? before.length + 1 : before.length - lastNewline
    return ` at line ${line}, column ${column}`
  }
  const lineMatch = /line (\d+) column (\d+)/.exec(msg)
  if (lineMatch) return ` at line ${lineMatch[1]}, column ${lineMatch[2]}`
  return ''
}

/**
 * @param {unknown} cfg
 * @param {{ strict: boolean, stderr: { write: (s: string) => void } }} opts
 * @returns {asserts cfg is CollectivusConfig}
 */
function validateConfig(cfg, opts) {
  assertObject(cfg, '')
  // version is checked first so a v0 file fails with the documented hard
  // error instead of being routed through the unknown-key paths below.
  if (!Object.prototype.hasOwnProperty.call(cfg, 'version')) {
    throw new ConfigError(
      'missing "version" field. This collectivus binary requires version: 1.',
      { pointer: '/version' }
    )
  }
  if (cfg.version !== 1) {
    throw new ConfigError(
      `unsupported version ${JSON.stringify(cfg.version)}. This collectivus binary requires version: 1.`,
      { pointer: '/version' }
    )
  }

  if (opts.strict) {
    assertOnlyKeys(cfg, ALLOWED_TOP_KEYS, '')
  } else {
    warnUnknownTopKeys(cfg, opts.stderr)
  }

  if (cfg.otel !== undefined) validateOtel(cfg.otel)
  if (cfg.proxy !== undefined) validateProxy(cfg.proxy)
  if ((cfg.otel !== undefined || cfg.proxy !== undefined) && cfg.sink === undefined) {
    throw new ConfigError(
      'sink is required when otel or proxy is configured',
      { pointer: '/sink' }
    )
  }
  if (cfg.sink !== undefined) validateSink(cfg.sink)
  if (cfg.upload !== undefined) validateUpload(cfg.upload)
}

/** @param {unknown} otel */
function validateOtel(otel) {
  assertObject(otel, '/otel')
  assertOnlyKeys(otel, new Set(['listen']), '/otel')
  assertNonEmptyString(otel.listen, '/otel/listen')
}

/** @param {unknown} proxy */
function validateProxy(proxy) {
  assertObject(proxy, '/proxy')
  assertOnlyKeys(proxy, ALLOWED_PROXY_KEYS, '/proxy')
  assertNonEmptyString(proxy.listen, '/proxy/listen')

  if (proxy.upstreams === undefined) {
    throw new ConfigError('upstreams is required', { pointer: '/proxy/upstreams' })
  }
  if (!Array.isArray(proxy.upstreams)) {
    throw new ConfigError('must be an array', { pointer: '/proxy/upstreams' })
  }
  if (proxy.upstreams.length === 0) {
    throw new ConfigError('at least one upstream is required', { pointer: '/proxy/upstreams' })
  }
  /** @type {Set<string>} */
  const seen = new Set()
  proxy.upstreams.forEach(function(u, i) {
    const pointer = `/proxy/upstreams/${i}`
    validateUpstream(u, pointer)
    // validateUpstream guarantees `name` is a non-empty string above. The
    // cast keeps the duplicate-name check working under strict typing.
    const { name } = /** @type {{ name: string }} */ (u)
    if (seen.has(name)) {
      throw new ConfigError(
        `duplicate upstream name "${name}"`,
        { pointer: `${pointer}/name` }
      )
    }
    seen.add(name)
  })

  if (proxy.redact_headers !== undefined) {
    if (!Array.isArray(proxy.redact_headers)) {
      throw new ConfigError('must be an array of strings', { pointer: '/proxy/redact_headers' })
    }
    proxy.redact_headers.forEach(function(h, i) {
      if (typeof h !== 'string' || h.length === 0) {
        throw new ConfigError('must be a non-empty string', { pointer: `/proxy/redact_headers/${i}` })
      }
    })
  }
}

/**
 * @param {unknown} upstream
 * @param {string} pointer
 */
function validateUpstream(upstream, pointer) {
  assertObject(upstream, pointer)
  assertOnlyKeys(upstream, ALLOWED_UPSTREAM_KEYS, pointer)
  assertNonEmptyString(upstream.name, `${pointer}/name`)
  assertNonEmptyString(upstream.base_url, `${pointer}/base_url`)
  if (upstream.match === undefined) {
    throw new ConfigError('match is required', { pointer: `${pointer}/match` })
  }
  assertObject(upstream.match, `${pointer}/match`)
  assertOnlyKeys(upstream.match, new Set(['path_prefix']), `${pointer}/match`)
  assertNonEmptyString(upstream.match.path_prefix, `${pointer}/match/path_prefix`)
}

/** @param {unknown} sink */
function validateSink(sink) {
  assertObject(sink, '/sink')
  assertOnlyKeys(sink, ALLOWED_SINK_KEYS, '/sink')
  if (sink.type !== 'file') {
    throw new ConfigError('only sink type "file" is supported in v0', { pointer: '/sink/type' })
  }
  assertNonEmptyString(sink.dir, '/sink/dir')
}

/**
 * Validate the `upload` block. Schema only — no defaults are injected so
 * `--print-config` round-trips a v1 config unchanged. Defaults are applied
 * later when the uploader is wired in (co-zdn.7.3).
 *
 * @param {unknown} upload
 */
function validateUpload(upload) {
  assertObject(upload, '/upload')
  assertOnlyKeys(upload, ALLOWED_UPLOAD_KEYS, '/upload')
  assertNonEmptyString(upload.bucket, '/upload/bucket')
  if (upload.prefix !== undefined) assertNonEmptyString(upload.prefix, '/upload/prefix')
  if (upload.region !== undefined && typeof upload.region !== 'string') {
    throw new ConfigError('must be a string', { pointer: '/upload/region' })
  }
  if (upload.time !== undefined) {
    if (typeof upload.time !== 'string' || !TIME_PATTERN.test(upload.time)) {
      throw new ConfigError('must be HH:MM (24-hour)', { pointer: '/upload/time' })
    }
  }
  if (upload.signals !== undefined) {
    if (!Array.isArray(upload.signals)) {
      throw new ConfigError('must be an array', { pointer: '/upload/signals' })
    }
    upload.signals.forEach(function(s, i) {
      if (typeof s !== 'string' || !ALLOWED_SIGNALS.has(s)) {
        throw new ConfigError(
          'must be one of "logs", "traces", "metrics"',
          { pointer: `/upload/signals/${i}` }
        )
      }
    })
  }
  if (upload.catchupDays !== undefined) {
    if (typeof upload.catchupDays !== 'number'
        || !Number.isInteger(upload.catchupDays)
        || upload.catchupDays < 0) {
      throw new ConfigError(
        'must be a non-negative integer',
        { pointer: '/upload/catchupDays' }
      )
    }
  }
  if (upload.endpoint !== undefined) assertNonEmptyString(upload.endpoint, '/upload/endpoint')
}

/**
 * @param {unknown} value
 * @param {string} pointer
 * @returns {asserts value is Record<string, unknown>}
 */
function assertObject(value, pointer) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ConfigError('must be an object', { pointer: pointer || '/' })
  }
}

/**
 * @param {Record<string, unknown>} obj
 * @param {Set<string>} allowed
 * @param {string} pointer - Pointer to the object being checked ('' for root).
 */
function assertOnlyKeys(obj, allowed, pointer) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new ConfigError(`unknown key "${key}"`, { pointer: `${pointer}/${key}` })
    }
  }
}

/**
 * Non-strict mode for top-level keys: log and continue. Per-section
 * validators still reject unknown keys to catch typos like `proxy.upsteams`.
 *
 * @param {Record<string, unknown>} obj
 * @param {{ write: (s: string) => void }} stderr
 */
function warnUnknownTopKeys(obj, stderr) {
  /** @type {string[]} */
  const unknown = []
  for (const key of Object.keys(obj)) {
    if (!ALLOWED_TOP_KEYS.has(key)) unknown.push(key)
  }
  if (unknown.length === 0) return
  const recognized = Array.from(ALLOWED_TOP_KEYS).map((k) => `"${k}"`).join(', ')
  for (const key of unknown) {
    stderr.write(
      `warning: unknown config key "${key}" ignored ` +
      `(this collectivus binary recognizes: ${recognized})\n`
    )
  }
}

/**
 * @param {unknown} value
 * @param {string} pointer
 * @returns {asserts value is string}
 */
function assertNonEmptyString(value, pointer) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigError('must be a non-empty string', { pointer })
  }
}
