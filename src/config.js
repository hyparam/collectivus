import fs from 'node:fs'

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

const ALLOWED_TOP_KEYS = new Set(['otel', 'proxy', 'sink'])
const ALLOWED_PROXY_KEYS = new Set(['listen', 'upstreams', 'redact_headers'])
const ALLOWED_UPSTREAM_KEYS = new Set(['base_url', 'match'])
const ALLOWED_SINK_KEYS = new Set(['type', 'dir'])

/**
 * Load and validate a collectivus JSON config file.
 *
 * @param {string} configPath - Absolute or relative path to a JSON config file.
 * @returns {CollectivusConfig} The parsed and validated config.
 * @throws {ConfigError} when the file is missing, JSON is invalid, or the schema check fails.
 */
export function loadConfig(configPath) {
  let raw
  try {
    raw = fs.readFileSync(configPath, 'utf8')
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : null
    if (code === 'ENOENT') {
      throw new ConfigError(`config file not found: ${configPath}`)
    }
    const msg = err instanceof Error ? err.message : String(err)
    throw new ConfigError(`failed to read ${configPath}: ${msg}`)
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const location = jsonErrorLocation(raw, msg)
    throw new ConfigError(`invalid JSON in ${configPath}${location}: ${msg}`)
  }

  validateConfig(parsed)
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
 * @returns {asserts cfg is CollectivusConfig}
 */
function validateConfig(cfg) {
  assertObject(cfg, '')
  assertOnlyKeys(cfg, ALLOWED_TOP_KEYS, '')

  if (cfg.otel !== undefined) validateOtel(cfg.otel)
  if (cfg.proxy !== undefined) validateProxy(cfg.proxy)
  if (cfg.proxy !== undefined && cfg.sink === undefined) {
    throw new ConfigError('sink is required when proxy is configured', { pointer: '/sink' })
  }
  if (cfg.sink !== undefined) validateSink(cfg.sink)
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
  assertObject(proxy.upstreams, '/proxy/upstreams')
  const names = Object.keys(proxy.upstreams)
  if (names.length === 0) {
    throw new ConfigError('at least one upstream is required', { pointer: '/proxy/upstreams' })
  }
  for (const name of names) {
    validateUpstream(proxy.upstreams[name], `/proxy/upstreams/${name}`)
  }

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
 * @param {unknown} value
 * @param {string} pointer
 * @returns {asserts value is string}
 */
function assertNonEmptyString(value, pointer) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ConfigError('must be a non-empty string', { pointer })
  }
}
