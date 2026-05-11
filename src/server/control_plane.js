import http from 'node:http'
import { readPackageVersion } from '../cli/common.js'
import { createBearerAuth, getClaims } from './auth.js'
import { createConfigRegistry, getConfig, resolveConfigsDir } from './config_registry.js'
import { clientIp, readJsonBody, writeError, writeJson, writeRetryAfterJson } from './http.js'
import {
  BootstrapStore,
  DEFAULT_JWT_TTL_SECONDS,
  issueFromBootstrap,
  signJwt,
} from './identity.js'
import { Ingest, defaultSinkDir } from './ingest.js'
import { SlidingWindowRateLimiter } from './rate_limit.js'

/**
 * @import { Server, IncomingMessage, ServerResponse } from 'node:http'
 * @import { CollectivusConfig, ServerConfig } from '../types.js'
 * @import { ConfigRegistry } from './types.d.ts'
 */

/** Maximum bytes accepted in an identity request body. */
const MAX_BODY_BYTES = 4 * 1024

/** Bootstrap rate limit: 5 requests per 60s per source IP. */
const BOOTSTRAP_RATE_WINDOW_MS = 60_000
const BOOTSTRAP_RATE_MAX = 5

/** Refresh rate limit: 1 request per 60s per gateway. */
const REFRESH_RATE_WINDOW_MS = 60_000
const REFRESH_RATE_MAX = 1

/**
 * Server-mode control-plane HTTP listener. Mounts the v0 identity endpoints
 * (`/v1/identity/bootstrap`, `/v1/identity/refresh`) plus a no-auth `/health`
 * probe. Future epics (B config vending, C log ingest) will mount additional
 * endpoints on this same listener — keep new routes inside `handleRequest`
 * rather than spawning another HTTP server.
 */
export class ControlPlane {
  /**
   * @param {ServerConfig} config
   * @param {{ bootstrapStore?: BootstrapStore, configRegistry?: ConfigRegistry, ingest?: Ingest, now?: () => number }} [opts]
   *   Test hooks. `bootstrapStore` overrides the file-backed store derived
   *   from `config.identity_issuer.bootstrap_store_path`. `configRegistry`
   *   overrides the file-backed registry derived from `config.data_dir`.
   *   `ingest` overrides the default `Ingest` instance (used by tests to
   *   inject a temp sink directory). `now` is injected into the JWT signer/
   *   verifier, rate limiters, and the ingest endpoint so tests can drive
   *   token expiry, rate-limit windows, and the date used for daily-rolled
   *   JSONL files.
   */
  constructor(config, opts = {}) {
    /** @type {ServerConfig} */
    this.config = config
    const { host, port } = parseListen(config.control_plane_listen)
    /** @type {string} */
    this.host = host
    /** @type {number} */
    this.port = port
    /** @type {Server | undefined} */
    this.server = undefined
    /** @type {() => number} */
    this.now = opts.now ?? Date.now
    /** @type {(req: IncomingMessage, res: ServerResponse) => boolean} */
    this.authorize = createBearerAuth(config.identity_issuer, { now: this.now })

    /** @type {BootstrapStore | undefined} */
    this.bootstrapStore = opts.bootstrapStore
    if (!this.bootstrapStore && config.identity_issuer.bootstrap_store_path) {
      this.bootstrapStore = new BootstrapStore({
        path: config.identity_issuer.bootstrap_store_path,
        now: this.now,
      })
    }

    /** @type {ConfigRegistry} */
    this.configRegistry = opts.configRegistry ?? createConfigRegistry({
      configsDir: resolveConfigsDir(config),
    })

    /** @type {SlidingWindowRateLimiter} */
    this.bootstrapLimiter = new SlidingWindowRateLimiter({
      windowMs: BOOTSTRAP_RATE_WINDOW_MS,
      max: BOOTSTRAP_RATE_MAX,
      now: this.now,
    })
    /** @type {SlidingWindowRateLimiter} */
    this.refreshLimiter = new SlidingWindowRateLimiter({
      windowMs: REFRESH_RATE_WINDOW_MS,
      max: REFRESH_RATE_MAX,
      now: this.now,
    })

    /** @type {Ingest} */
    this.ingest = opts.ingest ?? new Ingest({
      sinkDir: config.sink_dir ?? defaultSinkDir(),
      now: this.now,
      // Forward the optional ingest throttle config; each `undefined` falls
      // through to the spec-mandated default inside `Ingest`.
      maxPendingRows: config.ingest?.max_pending_rows,
      highWaterPct: config.ingest?.high_water_pct,
      retryAfterSeconds: config.ingest?.retry_after_seconds,
      maxBytesPerSecond: config.ingest?.max_bytes_per_second,
    })
  }

  /**
   * Bind the control-plane listener. Rejects with the bind error (e.g.
   * EADDRINUSE) rather than emitting an unhandled `error` event, so the CLI
   * can fail fast instead of hanging on `await start()`.
   *
   * @returns {Promise<void>}
   */
  start() {
    const server = http.createServer((req, res) => this.handleRequest(req, res))
    this.server = server
    return new Promise((resolve, reject) => {
      /** @param {Error} err */
      function onError(err) {
        server.off('listening', onListening)
        reject(err)
      }
      function onListening() {
        server.off('error', onError)
        resolve(undefined)
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen(this.port, this.host)
    })
  }

  /**
   * Close the control-plane listener.
   *
   * @returns {Promise<void>}
   */
  stop() {
    return new Promise((resolve, reject) => {
      const { server } = this
      if (!server) {
        resolve(undefined)
        return
      }
      server.close((err) => {
        if (err) reject(err)
        else {
          this.server = undefined
          resolve(undefined)
        }
      })
    })
  }

  /**
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   * @returns {void}
   */
  handleRequest(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host || 'localhost'}`)
    const path = url.pathname
    const method = req.method ?? ''

    if (path === '/health') {
      if (method !== 'GET') return writeError(res, 405, 'method not allowed')
      writeJson(res, 200, { status: 'ok', version: readPackageVersion() })
      return
    }

    if (path === '/v1/identity/bootstrap') {
      if (method !== 'POST') return writeError(res, 405, 'method not allowed')
      this.handleBootstrap(req, res)
      return
    }

    if (path === '/v1/identity/refresh') {
      if (method !== 'POST') return writeError(res, 405, 'method not allowed')
      if (!this.authorize(req, res)) return
      if (!this.ensureGatewayRegistered(req, res)) return
      this.handleRefresh(req, res)
      return
    }

    if (path === '/v1/bootstrap-config') {
      if (method !== 'GET') return writeError(res, 405, 'method not allowed')
      this.handleBootstrapConfig(req, res, url)
      return
    }

    if (path === '/v1/config') {
      if (method !== 'GET') return writeError(res, 405, 'method not allowed')
      if (!this.authorize(req, res)) return
      this.handleGetConfig(req, res)
      return
    }

    if (path.startsWith('/v1/ingest/')) {
      if (method !== 'POST') return writeError(res, 405, 'method not allowed')
      if (!this.authorize(req, res)) return
      if (!this.ensureGatewayRegistered(req, res)) return
      const signal = path.slice('/v1/ingest/'.length)
      this.ingest.handleRequest(req, res, signal).catch((err) => {
        // `Ingest.handleRequest` writes its own 4xx/5xx responses for
        // expected failures. A throw escaping it means a programming bug
        // (e.g. an unhandled file-system error path) — emit a terse 500
        // only when the response is still open.
        if (!res.writableEnded) {
          const msg = err instanceof Error ? err.message : String(err)
          writeError(res, 500, `ingest dispatch failed: ${msg}`)
        }
      })
      return
    }

    writeError(res, 404, 'not found')
  }

  /**
   * Handle `POST /v1/identity/bootstrap`. Per-IP rate limit is enforced
   * before body parsing so an attacker with a known IP can't exhaust memory
   * by hammering with large bodies.
   *
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   * @returns {void}
   */
  handleBootstrap(req, res) {
    const ip = clientIp(req)
    const limit = this.bootstrapLimiter.check(ip)
    if (!limit.allowed) return writeRateLimited(res, limit.retryAfterMs)

    const store = this.bootstrapStore
    if (!store) {
      // Server is configured without a bootstrap store — refresh works,
      // but new gateway enrollment is intentionally disabled.
      writeJson(res, 503, { error: 'bootstrap not provisioned' })
      return
    }

    readJsonBody(req, MAX_BODY_BYTES).then((body) => {
      if (body.error) return writeError(res, body.status, body.error)
      const parsed = body.value
      if (!isPlainObject(parsed) || typeof parsed.bootstrap_token !== 'string') {
        return writeError(res, 400, 'bootstrap_token is required')
      }
      const token = parsed.bootstrap_token
      if (token.length === 0) return writeError(res, 400, 'bootstrap_token is required')

      const result = issueFromBootstrap(token, store, this.config.identity_issuer, { now: this.now })
      if (result.ok === false) {
        // All consume failures map to 401 — a leaked store should not leak
        // *which* tokens are known/already-used/expired via status code
        // differentiation.
        const { reason } = result
        return writeJson(res, 401, { error: 'invalid bootstrap token', reason })
      }
      writeJson(res, 200, { jwt: result.jwt, expires_at: result.expiresAt })
    }).catch((err) => {
      const msg = err instanceof Error ? err.message : String(err)
      writeError(res, 500, `bootstrap failed: ${msg}`)
    })
  }

  /**
   * Handle `POST /v1/identity/refresh`. Caller must already be authenticated
   * via `this.authorize`.
   *
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   * @returns {void}
   */
  handleRefresh(req, res) {
    const claims = getClaims(req)
    if (!claims) {
      // Defense in depth — auth middleware wrote 401 already on failure;
      // reaching here without claims means something is wired wrong.
      return writeError(res, 500, 'auth claims missing after authorize')
    }
    const limit = this.refreshLimiter.check(claims.sub)
    if (!limit.allowed) return writeRateLimited(res, limit.retryAfterMs)

    const issuer = this.config.identity_issuer
    const ttlSeconds = issuer.jwt_ttl_seconds ?? DEFAULT_JWT_TTL_SECONDS
    const jwt = signJwt({
      gatewayId: claims.sub,
      ttlSeconds,
      secret: issuer.secret,
      now: this.now,
    })
    const expiresAt = Math.floor(this.now() / 1000) + ttlSeconds
    writeJson(res, 200, { jwt, expires_at: expiresAt })
  }

  /**
   * Handle `GET /v1/bootstrap-config?token=...`. The URL itself is the
   * invite: it carries a one-shot bootstrap token and returns the minimal
   * gateway config needed for `npx collectivus --config-endpoint=...` to
   * bootstrap identity, start the config poll loop, and hot-reload the
   * registered per-gateway config.
   *
   * Fetching this endpoint does not consume the token. The token is consumed
   * only by `POST /v1/identity/bootstrap` after the gateway process starts.
   *
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   * @param {URL} url
   * @returns {void}
   */
  handleBootstrapConfig(req, res, url) {
    const store = this.bootstrapStore
    if (!store) {
      writeJson(res, 503, { error: 'bootstrap not provisioned' })
      return
    }
    const token = url.searchParams.get('token') ?? url.searchParams.get('bootstrap_token') ?? ''
    if (token.length === 0) {
      writeError(res, 400, 'token is required')
      return
    }
    const inspected = store.inspect(token)
    if (inspected.ok === false) {
      return writeJson(res, 401, { error: 'invalid bootstrap token', reason: inspected.reason })
    }

    const centralUrl = normalizeBaseUrl(this.config.public_url ?? requestBaseUrl(req))
    /** @type {CollectivusConfig} */
    let config = {
      version: 1,
      role: 'gateway',
      central_server: {
        url: centralUrl,
        identity: {},
      },
    }
    try {
      const entry = getConfig(this.configRegistry, inspected.gatewayId)
      if (entry) config = entry.config
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return writeError(res, 500, `config registry error: ${msg}`)
    }

    writeJson(res, 200, withBootstrapToken(config, centralUrl, token), {
      'cache-control': 'no-store',
    })
  }

  /**
   * Require a registered per-gateway config for ordinary gateway JWT use.
   * Bootstrap remains governed by bootstrap tokens, but once a config is
   * deleted the old gateway JWT can no longer ingest or renew itself.
   *
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   * @returns {boolean}
   */
  ensureGatewayRegistered(req, res) {
    const claims = getClaims(req)
    if (!claims) {
      writeError(res, 500, 'auth claims missing after authorize')
      return false
    }
    try {
      if (getConfig(this.configRegistry, claims.sub)) return true
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      writeError(res, 500, `config registry error: ${msg}`)
      return false
    }
    writeJson(res, 401, {
      error: 'unauthorized',
      reason: 'no config registered for this gateway',
    })
    return false
  }

  /**
   * Handle `GET /v1/config`. Caller must already be authenticated via
   * `this.authorize`. The gateway_id is always read from the JWT `sub` claim
   * (never from a query parameter) so a gateway cannot fetch another
   * gateway's config by spoofing a path or query string.
   *
   * Conditional GET: clients send `If-None-Match: <etag>`; when the ETag
   * matches the registry entry, respond 304 with no body. Otherwise return
   * 200 + the config JSON + an `ETag` response header.
   *
   * @param {IncomingMessage} req
   * @param {ServerResponse} res
   * @returns {void}
   */
  handleGetConfig(req, res) {
    const claims = getClaims(req)
    if (!claims) {
      return writeError(res, 500, 'auth claims missing after authorize')
    }
    /** @type {ReturnType<typeof getConfig>} */
    let entry
    try {
      entry = getConfig(this.configRegistry, claims.sub)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return writeError(res, 500, `config registry error: ${msg}`)
    }
    if (!entry) {
      return writeError(res, 404, 'no config registered for this gateway')
    }
    const ifNoneMatch = req.headers['if-none-match']
    if (typeof ifNoneMatch === 'string' && etagMatches(ifNoneMatch, entry.etag)) {
      res.writeHead(304, { 'etag': entry.etag })
      res.end()
      return
    }
    writeJson(res, 200, entry.config, { 'etag': entry.etag })
  }
}

/**
 * Parse a `host:port` listen string. Bracketed IPv6 addresses are unwrapped.
 * Mirrors the validator in `src/config.js#assertHostPort` so the runtime check
 * never disagrees with the schema check.
 *
 * @param {string} value
 * @returns {{ host: string, port: number }}
 */
function parseListen(value) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`invalid listen address: ${value}`)
  }
  let host = ''
  let portStr = ''
  if (value.startsWith('[')) {
    const close = value.indexOf(']')
    if (close === -1) throw new Error(`invalid listen address: ${value}`)
    host = value.slice(1, close)
    if (value[close + 1] !== ':') throw new Error(`invalid listen address: ${value}`)
    portStr = value.slice(close + 2)
  } else {
    const colon = value.lastIndexOf(':')
    if (colon <= 0) throw new Error(`invalid listen address: ${value}`)
    host = value.slice(0, colon)
    portStr = value.slice(colon + 1)
  }
  const port = Number.parseInt(portStr, 10)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid port in listen address: ${value}`)
  }
  return { host, port }
}

/**
 * @param {ServerResponse} res
 * @param {number} retryAfterMs
 */
function writeRateLimited(res, retryAfterMs) {
  const retryAfterSec = Math.max(1, Math.ceil(retryAfterMs / 1000))
  writeRetryAfterJson(res, 429, { error: 'rate limited', retry_after_seconds: retryAfterSec }, retryAfterSec)
}

/**
 * @param {unknown} v
 * @returns {v is Record<string, unknown>}
 */
function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/**
 * Compare an `If-None-Match` header value against the current ETag. Accepts
 * weak (`W/"abc"`) and strong (`"abc"`) entity tags, and the unquoted bare
 * form some HTTP libraries produce. For our use case any equal token wins —
 * we never emit weak tags ourselves, but a relaxed match avoids unnecessary
 * 200s when a client library quotes them inconsistently.
 *
 * Multiple comma-separated tags are supported: any one match returns true.
 * The wildcard `*` is treated as a match per RFC 7232 §3.2.
 *
 * @param {string} headerValue
 * @param {string} currentEtag
 * @returns {boolean}
 */
function etagMatches(headerValue, currentEtag) {
  for (const raw of headerValue.split(',')) {
    const tag = stripEtagWrapping(raw.trim())
    if (tag.length === 0) continue
    if (tag === '*' || tag === currentEtag) return true
  }
  return false
}

/**
 * Return the registered gateway config with the current bootstrap token
 * overlaid so first start can still acquire identity. When no registered
 * config exists, callers pass the starter config built by `handleBootstrapConfig`.
 *
 * @param {CollectivusConfig} config
 * @param {string} centralUrl
 * @param {string} token
 * @returns {CollectivusConfig}
 */
function withBootstrapToken(config, centralUrl, token) {
  const central = config.central_server ?? { url: centralUrl, identity: {} }
  return {
    ...config,
    central_server: {
      ...central,
      url: central.url ?? centralUrl,
      identity: {
        ...central.identity,
        bootstrap_token: token,
      },
    },
  }
}

/**
 * @param {string} tag
 * @returns {string}
 */
function stripEtagWrapping(tag) {
  let t = tag
  if (t.startsWith('W/')) t = t.slice(2)
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    t = t.slice(1, -1)
  }
  return t
}

/**
 * @param {IncomingMessage} req
 * @returns {string}
 */
function requestBaseUrl(req) {
  const forwardedProto = firstHeaderValue(req.headers['x-forwarded-proto'])
  const forwardedHost = firstHeaderValue(req.headers['x-forwarded-host'])
  const proto = forwardedProto ?? 'http'
  const host = forwardedHost ?? firstHeaderValue(req.headers.host) ?? 'localhost'
  return `${proto}://${host}`
}

/**
 * @param {string | string[] | undefined} value
 * @returns {string | undefined}
 */
function firstHeaderValue(value) {
  if (Array.isArray(value)) return value[0]
  if (typeof value !== 'string' || value.length === 0) return undefined
  return value.split(',')[0].trim()
}

/**
 * @param {string} value
 * @returns {string}
 */
function normalizeBaseUrl(value) {
  return value.replace(/\/+$/, '')
}
