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

const ALLOWED_TOP_KEYS = new Set([
  'version', 'role', 'otel', 'proxy', 'sink', 'upload', 'server', 'central_server',
])
const ALLOWED_PROXY_KEYS = new Set(['listen', 'upstreams', 'redact_headers'])
const ALLOWED_UPSTREAM_KEYS = new Set(['name', 'base_url', 'match'])
const ALLOWED_SINK_KEYS = new Set(['type', 'dir'])
const ALLOWED_UPLOAD_KEYS = new Set([
  'bucket', 'prefix', 'region', 'time', 'signals', 'catchupDays', 'endpoint',
])
const ALLOWED_SERVER_KEYS = new Set(['control_plane_listen', 'identity_issuer', 'data_dir'])
const ALLOWED_IDENTITY_ISSUER_KEYS = new Set([
  'secret', 'jwt_ttl_seconds', 'bootstrap_ttl_seconds', 'bootstrap_store_path',
])
const ALLOWED_CENTRAL_SERVER_KEYS = new Set(['url', 'identity'])
const ALLOWED_CENTRAL_IDENTITY_KEYS = new Set(['bootstrap_token', 'persisted_path'])
const ALLOWED_ROLES = new Set(['server', 'gateway', 'standalone'])
const ALLOWED_SIGNALS = new Set(['logs', 'traces', 'metrics'])
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/
const IDENTITY_SECRET_MIN_LENGTH = 32

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

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const location = jsonErrorLocation(raw, msg)
    throw new ConfigError(`invalid JSON in ${configPath}${location}: ${msg}`)
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
 * Validate an in-memory config object the way a gateway would when loading
 * one off disk. Used by the server-side config registry to reject configs at
 * write time that would fail to load on the receiving gateway.
 *
 * Defaults match `loadConfig`: non-strict (unknown top keys warn, not error),
 * stderr swallowed so the validator can be called from non-CLI contexts.
 *
 * @param {unknown} cfg
 * @param {{ strict?: boolean, stderr?: { write: (s: string) => void } }} [opts]
 * @returns {asserts cfg is CollectivusConfig}
 */
export function validateCollectivusConfig(cfg, opts = {}) {
  validateConfig(cfg, {
    strict: opts.strict ?? false,
    stderr: opts.stderr ?? { write: () => {} },
  })
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
  validateRole(cfg)
}

/**
 * Validate `role` and the role-bound `server` / `central_server` blocks.
 *
 * The role-↔-block contract is enforced here rather than inside the per-block
 * validators because the constraints are cross-field (a `server` block alone
 * is not enough to know whether it's allowed; we need `role` too). An absent
 * `role` is treated as `standalone`.
 *
 * @param {Record<string, unknown>} cfg
 */
function validateRole(cfg) {
  const role = cfg.role === undefined ? 'standalone' : cfg.role
  if (typeof role !== 'string' || !ALLOWED_ROLES.has(role)) {
    throw new ConfigError(
      'must be one of "server", "gateway", "standalone"',
      { pointer: '/role' }
    )
  }
  if (role === 'server') {
    if (cfg.server === undefined) {
      throw new ConfigError(
        'server block is required when role is "server"',
        { pointer: '/server' }
      )
    }
    if (cfg.central_server !== undefined) {
      throw new ConfigError(
        'central_server is not permitted when role is "server"',
        { pointer: '/central_server' }
      )
    }
    validateServer(cfg.server)
  } else if (role === 'gateway') {
    if (cfg.central_server === undefined) {
      throw new ConfigError(
        'central_server block is required when role is "gateway"',
        { pointer: '/central_server' }
      )
    }
    if (cfg.server !== undefined) {
      throw new ConfigError(
        'server is not permitted when role is "gateway"',
        { pointer: '/server' }
      )
    }
    validateCentralServer(cfg.central_server)
  } else {
    if (cfg.server !== undefined) {
      throw new ConfigError(
        'server is only permitted when role is "server"',
        { pointer: '/server' }
      )
    }
    if (cfg.central_server !== undefined) {
      throw new ConfigError(
        'central_server is only permitted when role is "gateway"',
        { pointer: '/central_server' }
      )
    }
  }
}

/** @param {unknown} server */
function validateServer(server) {
  assertObject(server, '/server')
  assertOnlyKeys(server, ALLOWED_SERVER_KEYS, '/server')
  if (server.control_plane_listen === undefined) {
    throw new ConfigError(
      'control_plane_listen is required',
      { pointer: '/server/control_plane_listen' }
    )
  }
  assertHostPort(server.control_plane_listen, '/server/control_plane_listen')
  if (server.identity_issuer === undefined) {
    throw new ConfigError(
      'identity_issuer is required',
      { pointer: '/server/identity_issuer' }
    )
  }
  validateIdentityIssuer(server.identity_issuer)
  if (server.data_dir !== undefined) {
    assertNonEmptyString(server.data_dir, '/server/data_dir')
  }
}

/** @param {unknown} issuer */
function validateIdentityIssuer(issuer) {
  assertObject(issuer, '/server/identity_issuer')
  assertOnlyKeys(issuer, ALLOWED_IDENTITY_ISSUER_KEYS, '/server/identity_issuer')
  assertNonEmptyString(issuer.secret, '/server/identity_issuer/secret')
  if (issuer.secret.length < IDENTITY_SECRET_MIN_LENGTH) {
    throw new ConfigError(
      `must be at least ${IDENTITY_SECRET_MIN_LENGTH} characters`,
      { pointer: '/server/identity_issuer/secret' }
    )
  }
  if (issuer.jwt_ttl_seconds !== undefined) {
    assertPositiveInteger(issuer.jwt_ttl_seconds, '/server/identity_issuer/jwt_ttl_seconds')
  }
  if (issuer.bootstrap_ttl_seconds !== undefined) {
    assertPositiveInteger(issuer.bootstrap_ttl_seconds, '/server/identity_issuer/bootstrap_ttl_seconds')
  }
  if (issuer.bootstrap_store_path !== undefined) {
    assertNonEmptyString(issuer.bootstrap_store_path, '/server/identity_issuer/bootstrap_store_path')
  }
}

/** @param {unknown} cs */
function validateCentralServer(cs) {
  assertObject(cs, '/central_server')
  assertOnlyKeys(cs, ALLOWED_CENTRAL_SERVER_KEYS, '/central_server')
  if (cs.url === undefined) {
    throw new ConfigError('url is required', { pointer: '/central_server/url' })
  }
  assertParseableUrl(cs.url, '/central_server/url')
  if (cs.identity === undefined) {
    throw new ConfigError(
      'identity is required',
      { pointer: '/central_server/identity' }
    )
  }
  validateCentralIdentity(cs.identity)
}

/** @param {unknown} identity */
function validateCentralIdentity(identity) {
  assertObject(identity, '/central_server/identity')
  assertOnlyKeys(identity, ALLOWED_CENTRAL_IDENTITY_KEYS, '/central_server/identity')
  if (identity.bootstrap_token !== undefined) {
    assertNonEmptyString(identity.bootstrap_token, '/central_server/identity/bootstrap_token')
  }
  if (identity.persisted_path !== undefined) {
    assertNonEmptyString(identity.persisted_path, '/central_server/identity/persisted_path')
  }
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

/**
 * Mirrors the listen-address parsing in `proxy.js`: a non-empty string with a
 * colon, a valid 0..65535 port, and a non-empty host (IPv6 literals may be
 * wrapped in `[]`). Validation only — the value is bound to a server later.
 *
 * @param {unknown} value
 * @param {string} pointer
 */
function assertHostPort(value, pointer) {
  assertNonEmptyString(value, pointer)
  const idx = value.lastIndexOf(':')
  if (idx === -1) {
    throw new ConfigError('must be host:port', { pointer })
  }
  const portStr = value.slice(idx + 1)
  const port = Number.parseInt(portStr, 10)
  if (Number.isNaN(port) || port < 0 || port > 65535 || String(port) !== portStr) {
    throw new ConfigError('invalid port in host:port', { pointer })
  }
  const rawHost = value.slice(0, idx)
  const host = rawHost.startsWith('[') && rawHost.endsWith(']')
    ? rawHost.slice(1, -1)
    : rawHost
  if (host.length === 0) {
    throw new ConfigError('missing host in host:port', { pointer })
  }
}

/**
 * @param {unknown} value
 * @param {string} pointer
 */
function assertParseableUrl(value, pointer) {
  assertNonEmptyString(value, pointer)
  try {
    new URL(value)
  } catch {
    throw new ConfigError('must be a parseable URL', { pointer })
  }
}

/**
 * @param {unknown} value
 * @param {string} pointer
 */
function assertPositiveInteger(value, pointer) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ConfigError('must be a positive integer', { pointer })
  }
}
