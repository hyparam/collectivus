import http from 'node:http'
import https from 'node:https'
import { isSseHeaders } from './sse.js'

/**
 * @import { Server, IncomingMessage, ServerResponse, IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http'
 * @import { ProxyConfig, UpstreamConfig, CompiledUpstream, ClientInfo } from './types.js'
 * @import { Recorder, Exchange } from './recorder.js'
 */

/**
 * Hop-by-hop headers per RFC 7230 §6.1. These are scoped to a single transport
 * connection and must not be forwarded by intermediaries.
 */
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
])

/**
 * Reverse-proxy listener that forwards matched requests to a configured upstream.
 *
 * Pass-through plus optional recording: when constructed with a `recorder`,
 * each exchange is captured (request, response or stream events) and written
 * to the recorder's sink. Recording is purely observational — failures inside
 * the recorder must not break the proxy hot path.
 */
export class Proxy {
  /**
   * @param {ProxyConfig} config
   * @param {{ recorder?: Recorder }} [options]
   */
  constructor(config, options = {}) {
    /** @type {ProxyConfig} */
    this.config = config
    const { host, port } = parseListen(config.listen)
    /** @type {string} */
    this.host = host
    /** @type {number} */
    this.port = port
    /** @type {CompiledUpstream[]} */
    this.upstreams = compileUpstreams(config.upstreams)
    /** @type {Recorder | null} */
    this.recorder = options.recorder ?? null
    /** @type {Server | null} */
    this.server = null
  }

  /**
   * Bind the proxy listener. Rejects with the bind error (e.g. EADDRINUSE)
   * rather than emitting an unhandled `error` event, so the CLI can fail
   * fast instead of hanging on `await start()`.
   * @returns {Promise<void>}
   */
  start() {
    const { upstreams, recorder } = this
    const server = http.createServer((req, res) => {
      handleRequest(upstreams, recorder, req, res)
    })
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
   * Close the proxy listener. Resolves once the underlying server is closed.
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
        if (err) {
          reject(err)
        } else {
          this.server = null
          resolve(undefined)
        }
      })
    })
  }
}

/**
 * Parse a `host:port` listen address. IPv6 literals may be wrapped in `[]`.
 *
 * @param {string} listen
 * @returns {{ host: string, port: number }}
 */
function parseListen(listen) {
  if (typeof listen !== 'string' || listen.length === 0) {
    throw new Error(`invalid listen address: ${listen}`)
  }
  const idx = listen.lastIndexOf(':')
  if (idx === -1) {
    throw new Error(`invalid listen address (missing port): ${listen}`)
  }
  const rawHost = listen.slice(0, idx)
  const portStr = listen.slice(idx + 1)
  const port = Number.parseInt(portStr, 10)
  if (Number.isNaN(port) || port < 0 || port > 65535 || String(port) !== portStr) {
    throw new Error(`invalid port in listen address: ${listen}`)
  }
  const host = rawHost.startsWith('[') && rawHost.endsWith(']')
    ? rawHost.slice(1, -1)
    : rawHost
  if (host.length === 0) {
    throw new Error(`invalid listen address (missing host): ${listen}`)
  }
  return { host, port }
}

/**
 * Validate and pre-parse upstream URLs at startup so requests do not pay the
 * cost on every hop.
 *
 * @param {Object<string, UpstreamConfig>} upstreams
 * @returns {CompiledUpstream[]}
 */
function compileUpstreams(upstreams) {
  /** @type {CompiledUpstream[]} */
  const out = []
  for (const name of Object.keys(upstreams)) {
    const u = upstreams[name]
    let baseUrl
    try {
      baseUrl = new URL(u.base_url)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      throw new Error(`invalid base_url for upstream "${name}": ${msg}`)
    }
    if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
      throw new Error(
        `upstream "${name}" must use http:// or https://, got: ${baseUrl.protocol}`
      )
    }
    out.push({ name, baseUrl, prefix: u.match.path_prefix })
  }
  return out
}

/**
 * @param {CompiledUpstream[]} upstreams
 * @param {Recorder | null} recorder
 * @param {IncomingMessage} req
 * @param {ServerResponse} res
 */
function handleRequest(upstreams, recorder, req, res) {
  const requestUrl = req.url ?? '/'
  const url = new URL(requestUrl, 'http://placeholder')
  const upstream = matchUpstream(upstreams, url.pathname)
  if (!upstream) {
    sendJson(res, 404, { error: 'no upstream matches path', path: url.pathname })
    req.resume()
    return
  }

  const isHttps = upstream.baseUrl.protocol === 'https:'
  const lib = isHttps ? https : http
  const upstreamHost = upstream.baseUrl.host
  const upstreamPort = upstream.baseUrl.port
    ? Number.parseInt(upstream.baseUrl.port, 10)
    : isHttps ? 443 : 80

  const headers = forwardHeaders(req.headers, upstreamHost)

  const exchange = recorder?.startExchange({
    upstream: upstream.name,
    client: clientInfo(req),
    request: {
      method: req.method,
      path: requestUrl,
      headers: req.headers,
    },
  }) ?? null

  const upstreamReq = lib.request({
    method: req.method,
    protocol: upstream.baseUrl.protocol,
    hostname: upstream.baseUrl.hostname,
    port: upstreamPort,
    path: url.pathname + url.search,
    headers,
  }, (upstreamRes) => {
    const responseHeaders = sanitizeResponseHeaders(upstreamRes.headers)
    res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.statusMessage, responseHeaders)
    if (exchange) {
      exchange.setResponseStart({
        status: upstreamRes.statusCode,
        headers: upstreamRes.headers,
      })
      const streaming = isSseHeaders(upstreamRes.headers)
      if (streaming) {
        exchange.markStreaming()
        upstreamRes.on('data', (chunk) => {
          // Recorder runs alongside the proxy hot path; failures here must
          // not break the response stream the client is consuming.
          exchange.consumeStreamChunk(chunk).catch((err) => exchange.setError(err))
        })
      } else {
        upstreamRes.on('data', (chunk) => {
          exchange.appendResponseChunk(chunk)
        })
      }
      upstreamRes.on('end', () => {
        finishSafely(exchange)
      })
      upstreamRes.on('error', (err) => {
        exchange.setError(err)
        finishSafely(exchange)
      })
    }
    upstreamRes.pipe(res)
  })

  let failed = false
  upstreamReq.on('error', (err) => {
    failed = true
    if (!res.headersSent) {
      sendJson(res, 502, { error: 'upstream connection failed', detail: err.message })
    } else {
      res.destroy(err)
    }
    req.resume()
    if (exchange) {
      if (!exchange.response) {
        exchange.setResponseStart({ status: 502, headers: {} })
      }
      exchange.setError(err)
      finishSafely(exchange)
    }
  })

  req.on('error', (err) => {
    upstreamReq.destroy()
    if (exchange) {
      exchange.setError(err)
      finishSafely(exchange)
    }
  })
  res.on('close', () => {
    if (!failed && !upstreamReq.destroyed) upstreamReq.destroy()
    if (exchange && !exchange.finished) {
      // Client gave up before the response completed — cancel upstream and
      // record what we have. The error sentinel is `client_aborted` per the
      // proxy contract so consumers can match on a stable machine-readable
      // value rather than a free-form Error.message string.
      exchange.setError('client_aborted')
      finishSafely(exchange)
    }
  })

  if (exchange) {
    req.on('data', (chunk) => exchange.appendRequestChunk(chunk))
  }
  req.pipe(upstreamReq)
}

/**
 * Capture client metadata once at exchange start so it survives socket
 * teardown later in the lifecycle.
 *
 * @param {IncomingMessage} req
 * @returns {ClientInfo}
 */
function clientInfo(req) {
  const remoteAddress = req.socket?.remoteAddress
  const ua = req.headers['user-agent']
  return {
    ip: typeof remoteAddress === 'string' ? remoteAddress : undefined,
    user_agent: typeof ua === 'string' ? ua : Array.isArray(ua) ? ua[0] : undefined,
  }
}

/**
 * Call `exchange.finish()` and swallow rejections — recording errors must not
 * propagate as unhandled rejections that could crash the process.
 *
 * @param {Exchange} exchange
 * @returns {void}
 */
function finishSafely(exchange) {
  exchange.finish().catch(() => {})
}

/**
 * Path-segment prefix match. `/v1/messages` matches `/v1/messages` and
 * `/v1/messages/anything`, but not `/v1/messagesfoo`. A `/` prefix is a
 * catch-all.
 *
 * @param {CompiledUpstream[]} upstreams
 * @param {string} pathname
 * @returns {CompiledUpstream | null}
 */
function matchUpstream(upstreams, pathname) {
  for (const u of upstreams) {
    if (u.prefix === '/') return u
    if (pathname === u.prefix || pathname.startsWith(u.prefix + '/')) {
      return u
    }
  }
  return null
}

/**
 * Build outbound headers from inbound headers. Strips hop-by-hop headers and
 * the inbound `Host`, then injects the upstream `Host`.
 *
 * @param {IncomingHttpHeaders} reqHeaders
 * @param {string} upstreamHost
 * @returns {OutgoingHttpHeaders}
 */
function forwardHeaders(reqHeaders, upstreamHost) {
  /** @type {OutgoingHttpHeaders} */
  const out = {}
  for (const key of Object.keys(reqHeaders)) {
    const lower = key.toLowerCase()
    if (lower === 'host') continue
    if (HOP_BY_HOP_HEADERS.has(lower)) continue
    const value = reqHeaders[key]
    if (value === undefined) continue
    out[key] = value
  }
  out.host = upstreamHost
  return out
}

/**
 * Strip hop-by-hop headers from an upstream response before forwarding.
 *
 * @param {IncomingHttpHeaders} headers
 * @returns {OutgoingHttpHeaders}
 */
function sanitizeResponseHeaders(headers) {
  /** @type {OutgoingHttpHeaders} */
  const out = {}
  for (const key of Object.keys(headers)) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue
    const value = headers[key]
    if (value === undefined) continue
    out[key] = value
  }
  return out
}

/**
 * @param {ServerResponse} res
 * @param {number} status
 * @param {object} body
 */
function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}
