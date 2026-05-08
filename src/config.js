import fs from 'node:fs'

/**
 * @import { Signal, UploadOptions } from './upload/upload.d.ts'
 */

/**
 * @typedef {object} OtelConfig
 * @property {string} listen - host:port for the OTLP receiver (e.g. '0.0.0.0:4318').
 */

/**
 * @typedef {object} UpstreamMatch
 * @property {string} path_prefix - Request path prefix that selects this upstream.
 */

/**
 * @typedef {object} UpstreamConfig
 * @property {string} base_url - Origin to forward matched requests to.
 * @property {UpstreamMatch} match - Match rule for routing requests to this upstream.
 */

/**
 * @typedef {object} ProxyConfig
 * @property {string} listen - host:port the proxy listens on.
 * @property {Object<string, UpstreamConfig>} upstreams - Named upstream targets.
 * @property {string[]} [redact_headers] - Header names to redact in recorded traffic.
 */

/**
 * @typedef {object} FileSinkConfig
 * @property {'file'} type - Sink kind. Only 'file' is supported in v0.
 * @property {string} dir - Directory where recordings are written.
 */

/**
 * @typedef {object} CollectivusConfig
 * @property {OtelConfig} [otel] - OTLP receiver. Omit to disable.
 * @property {ProxyConfig} [proxy] - Proxy listener. Omit to disable.
 * @property {FileSinkConfig} [sink] - Sink for proxy recordings. Required when `proxy` is set.
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

/**
 * Resolve collector options from CLI args and environment.
 *
 * Precedence: argv > env > Collector defaults. Keys are only set when an
 * explicit value is provided; unset keys fall through to the constructor.
 *
 * @param {string[]} argv CLI arguments (without node/script name).
 * @param {NodeJS.ProcessEnv} env Environment variables.
 * @returns {{ port?: number, outputDir?: string, upload?: UploadOptions }} Options for Collector.
 */
export function resolveOptions(argv, env) {
  /** @type {{ port?: number, outputDir?: string, upload?: UploadOptions }} */
  const options = {}
  /** @type {Partial<UploadOptions>} */
  const upload = {}

  if (env.COLLECTIVUS_PORT) {
    const port = parseInt(env.COLLECTIVUS_PORT, 10)
    if (!Number.isNaN(port)) options.port = port
  }
  if (env.COLLECTIVUS_OUTPUT_DIR) {
    options.outputDir = env.COLLECTIVUS_OUTPUT_DIR
  }

  if (env.COLLECTIVUS_UPLOAD_BUCKET) upload.bucket = env.COLLECTIVUS_UPLOAD_BUCKET
  if (env.COLLECTIVUS_UPLOAD_PREFIX) upload.prefix = env.COLLECTIVUS_UPLOAD_PREFIX
  if (env.COLLECTIVUS_UPLOAD_TIME) upload.time = env.COLLECTIVUS_UPLOAD_TIME
  if (env.COLLECTIVUS_UPLOAD_SIGNALS) upload.signals = parseSignals(env.COLLECTIVUS_UPLOAD_SIGNALS)
  if (env.COLLECTIVUS_UPLOAD_CATCHUP_DAYS) {
    const n = parseInt(env.COLLECTIVUS_UPLOAD_CATCHUP_DAYS, 10)
    if (!Number.isNaN(n)) upload.catchupDays = n
  }
  if (env.AWS_REGION) upload.region = env.AWS_REGION
  if (env.COLLECTIVUS_UPLOAD_ENDPOINT) upload.endpoint = env.COLLECTIVUS_UPLOAD_ENDPOINT

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    function next() { return argv[++i] }
    if (arg === '--port' && argv[i + 1] !== undefined) {
      const port = parseInt(next(), 10)
      if (!Number.isNaN(port)) options.port = port
    } else if (arg.startsWith('--port=')) {
      const port = parseInt(arg.slice('--port='.length), 10)
      if (!Number.isNaN(port)) options.port = port
    } else if (arg === '--output' && argv[i + 1] !== undefined) {
      options.outputDir = next()
    } else if (arg.startsWith('--output=')) {
      options.outputDir = arg.slice('--output='.length)
    } else if (arg === '--upload-bucket' && argv[i + 1] !== undefined) {
      upload.bucket = next()
    } else if (arg.startsWith('--upload-bucket=')) {
      upload.bucket = arg.slice('--upload-bucket='.length)
    } else if (arg === '--upload-prefix' && argv[i + 1] !== undefined) {
      upload.prefix = next()
    } else if (arg.startsWith('--upload-prefix=')) {
      upload.prefix = arg.slice('--upload-prefix='.length)
    } else if (arg === '--upload-time' && argv[i + 1] !== undefined) {
      upload.time = next()
    } else if (arg.startsWith('--upload-time=')) {
      upload.time = arg.slice('--upload-time='.length)
    } else if (arg === '--upload-signals' && argv[i + 1] !== undefined) {
      upload.signals = parseSignals(next())
    } else if (arg.startsWith('--upload-signals=')) {
      upload.signals = parseSignals(arg.slice('--upload-signals='.length))
    } else if (arg === '--upload-catchup-days' && argv[i + 1] !== undefined) {
      const n = parseInt(next(), 10)
      if (!Number.isNaN(n)) upload.catchupDays = n
    } else if (arg.startsWith('--upload-catchup-days=')) {
      const n = parseInt(arg.slice('--upload-catchup-days='.length), 10)
      if (!Number.isNaN(n)) upload.catchupDays = n
    } else if (arg === '--upload-region' && argv[i + 1] !== undefined) {
      upload.region = next()
    } else if (arg.startsWith('--upload-region=')) {
      upload.region = arg.slice('--upload-region='.length)
    } else if (arg === '--upload-endpoint' && argv[i + 1] !== undefined) {
      upload.endpoint = next()
    } else if (arg.startsWith('--upload-endpoint=')) {
      upload.endpoint = arg.slice('--upload-endpoint='.length)
    }
  }

  if (upload.bucket) {
    options.upload = /** @type {UploadOptions} */ (upload)
  }

  return options
}

/**
 * Parse a comma-separated signal list. Throws on any unrecognized
 * token (including bad case like "Logs") or an empty result, so a
 * typo fails loudly instead of silently disabling all uploads.
 *
 * @param {string} value comma-separated signal list
 * @returns {ReadonlyArray<Signal>}
 */
function parseSignals(value) {
  /** @type {Signal[]} */
  const out = []
  for (const part of value.split(',')) {
    const trimmed = part.trim()
    if (trimmed === '') continue
    if (trimmed === 'logs' || trimmed === 'traces' || trimmed === 'metrics') {
      out.push(trimmed)
    } else {
      throw new Error(`invalid upload signal "${trimmed}", expected one of: logs, traces, metrics`)
    }
  }
  if (out.length === 0) {
    throw new Error('upload signals list is empty, expected one or more of: logs, traces, metrics')
  }
  return out
}
