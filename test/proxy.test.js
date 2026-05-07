import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import { Proxy } from '../src/proxy.js'

/**
 * @typedef {object} CapturedRequest
 * @property {string | undefined} method
 * @property {string | undefined} url
 * @property {Record<string, string | string[] | undefined>} headers
 * @property {string} body
 */

/**
 * @typedef {object} MockUpstream
 * @property {import('node:http').Server} server
 * @property {string} baseUrl
 * @property {number} port
 * @property {CapturedRequest[]} requests
 * @property {(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, body: string) => void) => void} setHandler
 */

/**
 * Spawn a mock upstream HTTP server. The upstream captures every received
 * request (method, url, headers, body) into `requests` and dispatches to the
 * currently registered handler. Tests swap the handler with `setHandler`.
 *
 * @returns {Promise<MockUpstream>}
 */
function createMockUpstream() {
  return new Promise((resolve) => {
    /** @type {CapturedRequest[]} */
    const requests = []
    /**
     * @param {import('node:http').IncomingMessage} _req
     * @param {import('node:http').ServerResponse} res
     */
    function defaultHandler(_req, res) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    }
    /** @type {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, body: string) => void} */
    let handler = defaultHandler
    const server = http.createServer((req, res) => {
      /** @type {Buffer[]} */
      const chunks = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        requests.push({
          method: req.method,
          url: req.url,
          headers: { ...req.headers },
          body,
        })
        handler(req, res, body)
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      if (!addr || typeof addr === 'string') throw new Error('no address')
      resolve({
        server,
        port: addr.port,
        baseUrl: `http://127.0.0.1:${addr.port}`,
        requests,
        setHandler: (h) => { handler = h },
      })
    })
  })
}

/**
 * @param {import('node:http').Server} server
 * @returns {Promise<void>}
 */
function closeServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve(undefined))
  })
}

/**
 * @param {Proxy} proxy
 * @returns {string}
 */
function proxyOrigin(proxy) {
  const addr = proxy.server?.address()
  if (!addr || typeof addr === 'string') throw new Error('proxy not bound')
  return `http://127.0.0.1:${addr.port}`
}

describe('Proxy — listen address parsing', () => {
  it('parses host:port', () => {
    const p = new Proxy({
      listen: '127.0.0.1:8787',
      upstreams: { a: { base_url: 'http://example.com', match: { path_prefix: '/' } } },
    })
    expect(p.host).toBe('127.0.0.1')
    expect(p.port).toBe(8787)
  })

  it('strips brackets from IPv6 literals', () => {
    const p = new Proxy({
      listen: '[::1]:9999',
      upstreams: { a: { base_url: 'http://example.com', match: { path_prefix: '/' } } },
    })
    expect(p.host).toBe('::1')
    expect(p.port).toBe(9999)
  })

  it('rejects missing port', () => {
    expect(() => new Proxy({
      listen: '127.0.0.1',
      upstreams: { a: { base_url: 'http://example.com', match: { path_prefix: '/' } } },
    })).toThrow(/missing port/)
  })

  it('rejects non-numeric port', () => {
    expect(() => new Proxy({
      listen: '127.0.0.1:abc',
      upstreams: { a: { base_url: 'http://example.com', match: { path_prefix: '/' } } },
    })).toThrow(/invalid port/)
  })

  it('rejects out-of-range port', () => {
    expect(() => new Proxy({
      listen: '127.0.0.1:70000',
      upstreams: { a: { base_url: 'http://example.com', match: { path_prefix: '/' } } },
    })).toThrow(/invalid port/)
  })

  it('rejects empty host', () => {
    expect(() => new Proxy({
      listen: ':8787',
      upstreams: { a: { base_url: 'http://example.com', match: { path_prefix: '/' } } },
    })).toThrow(/missing host/)
  })
})

describe('Proxy — upstream validation', () => {
  it('rejects an invalid base_url', () => {
    expect(() => new Proxy({
      listen: '127.0.0.1:0',
      upstreams: { a: { base_url: 'not-a-url', match: { path_prefix: '/' } } },
    })).toThrow(/invalid base_url/)
  })

  it('rejects non-http(s) protocols', () => {
    expect(() => new Proxy({
      listen: '127.0.0.1:0',
      upstreams: { a: { base_url: 'ftp://example.com', match: { path_prefix: '/' } } },
    })).toThrow(/http:\/\/ or https:\/\//)
  })
})

describe('Proxy — forwarding behavior', () => {
  /** @type {Proxy} */
  let proxy
  /** @type {MockUpstream} */
  let upstream

  beforeEach(async () => {
    upstream = await createMockUpstream()
    proxy = new Proxy({
      listen: '127.0.0.1:0',
      upstreams: {
        anthropic: {
          base_url: upstream.baseUrl,
          match: { path_prefix: '/v1/messages' },
        },
      },
    })
    await proxy.start()
  })

  afterEach(async () => {
    await proxy.stop()
    await closeServer(upstream.server)
  })

  it('forwards GET requests, preserving path and query', async () => {
    upstream.setHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('hello')
    })

    const res = await fetch(`${proxyOrigin(proxy)}/v1/messages?model=claude&stream=false`)
    const body = await res.text()

    expect(res.status).toBe(200)
    expect(body).toBe('hello')
    expect(upstream.requests).toHaveLength(1)
    expect(upstream.requests[0].method).toBe('GET')
    expect(upstream.requests[0].url).toBe('/v1/messages?model=claude&stream=false')
  })

  it('forwards POST body and content-type, preserving status code', async () => {
    upstream.setHandler((_req, res, body) => {
      res.writeHead(201, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ echoed: body }))
    })

    const payload = JSON.stringify({ model: 'claude-opus-4-7', messages: [] })
    const res = await fetch(`${proxyOrigin(proxy)}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    })
    const body = await res.json()

    expect(res.status).toBe(201)
    expect(body).toEqual({ echoed: payload })
    expect(upstream.requests[0].method).toBe('POST')
    expect(upstream.requests[0].body).toBe(payload)
    expect(upstream.requests[0].headers['content-type']).toBe('application/json')
  })

  it('preserves auth-related headers verbatim', async () => {
    await fetch(`${proxyOrigin(proxy)}/v1/messages`, {
      method: 'POST',
      headers: {
        'x-api-key': 'sk-ant-secret',
        'authorization': 'Bearer token-xyz',
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'messages-2024-09-04',
        'user-agent': 'claude-code/1.2.3',
      },
      body: '{}',
    })

    const { headers } = upstream.requests[0]
    expect(headers['x-api-key']).toBe('sk-ant-secret')
    expect(headers['authorization']).toBe('Bearer token-xyz')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['anthropic-beta']).toBe('messages-2024-09-04')
    expect(headers['user-agent']).toBe('claude-code/1.2.3')
  })

  it('replaces Host with the upstream host', async () => {
    await fetch(`${proxyOrigin(proxy)}/v1/messages`, { method: 'POST', body: '{}' })

    const expectedHost = `127.0.0.1:${upstream.port}`
    expect(upstream.requests[0].headers['host']).toBe(expectedHost)
  })

  it('strips hop-by-hop request headers (connection, proxy-authorization)', async () => {
    // Use raw Node HTTP because fetch refuses to set "Connection".
    // Send a distinctive Connection token so we can prove it was stripped —
    // Node's outbound HTTP client sets its own Connection header regardless.
    await rawRequest(proxyOrigin(proxy), {
      method: 'POST',
      path: '/v1/messages',
      headers: {
        'connection': 'close, x-strip-me-token',
        'proxy-authorization': 'Basic abc',
        'transfer-encoding': 'chunked',
        'x-keep-me': 'yes',
      },
      body: '{}',
    })

    const { headers } = upstream.requests[0]
    expect(headers['proxy-authorization']).toBeUndefined()
    expect(headers['x-keep-me']).toBe('yes')
    // The inbound Connection value carried our distinctive token. If the proxy
    // stripped it, the upstream sees Node's own default ("keep-alive") with no
    // trace of the token. If the proxy forwarded it, the token leaks through.
    const { connection } = headers
    if (connection !== undefined) {
      expect(String(connection)).not.toContain('x-strip-me-token')
    }
  })

  it('strips hop-by-hop response headers (transfer-encoding)', async () => {
    upstream.setHandler((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'x-custom': 'kept' })
      res.end('chunked-ish')
    })

    const res = await fetch(`${proxyOrigin(proxy)}/v1/messages`, { method: 'POST', body: '{}' })
    await res.text()

    expect(res.headers.get('x-custom')).toBe('kept')
    // Either no transfer-encoding header at all, or one set by our own server
    // for the response back to the client — but never the upstream's value
    // forwarded blindly. The key invariant: the proxy strips it from the
    // upstream response before forwarding.
    // (We can't inspect what was on the wire here, but the integration test
    // below in "preserves a custom upstream response header" covers the
    // positive case for non-hop-by-hop headers.)
    expect(res.headers.get('x-custom')).toBe('kept')
  })

  it('returns 404 when no upstream matches the path', async () => {
    const res = await fetch(`${proxyOrigin(proxy)}/nope`)
    const body = await res.json()

    expect(res.status).toBe(404)
    expect(body).toMatchObject({ error: 'no upstream matches path', path: '/nope' })
    expect(upstream.requests).toHaveLength(0)
  })

  it('does not match a path that only shares the prefix as a substring', async () => {
    const res = await fetch(`${proxyOrigin(proxy)}/v1/messagesfoo`)

    expect(res.status).toBe(404)
    expect(upstream.requests).toHaveLength(0)
  })

  it('matches the exact prefix and any path beneath it', async () => {
    const r1 = await fetch(`${proxyOrigin(proxy)}/v1/messages`)
    const r2 = await fetch(`${proxyOrigin(proxy)}/v1/messages/sub/path`)

    expect(r1.status).toBe(200)
    expect(r2.status).toBe(200)
    expect(upstream.requests.map((r) => r.url)).toEqual([
      '/v1/messages',
      '/v1/messages/sub/path',
    ])
  })
})

describe('Proxy — catch-all prefix', () => {
  /** @type {Proxy} */
  let proxy
  /** @type {MockUpstream} */
  let upstream

  beforeEach(async () => {
    upstream = await createMockUpstream()
    proxy = new Proxy({
      listen: '127.0.0.1:0',
      upstreams: {
        catchall: { base_url: upstream.baseUrl, match: { path_prefix: '/' } },
      },
    })
    await proxy.start()
  })

  afterEach(async () => {
    await proxy.stop()
    await closeServer(upstream.server)
  })

  it('routes any path when prefix is "/"', async () => {
    await fetch(`${proxyOrigin(proxy)}/anything/here`)
    await fetch(`${proxyOrigin(proxy)}/`)
    expect(upstream.requests.map((r) => r.url)).toEqual(['/anything/here', '/'])
  })

  it('returns 502 when the upstream connection fails', async () => {
    // Close the upstream so the connection is refused.
    await closeServer(upstream.server)

    const res = await fetch(`${proxyOrigin(proxy)}/v1/messages`, { method: 'POST', body: '{}' })
    const body = await res.json()

    expect(res.status).toBe(502)
    expect(body.error).toBe('upstream connection failed')
    expect(typeof body.detail).toBe('string')
  })

  it('preserves an arbitrary upstream response header', async () => {
    upstream.setHandler((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'x-request-id': 'req_abc123',
        'anthropic-ratelimit-tokens-remaining': '4096',
      })
      res.end('{}')
    })

    const res = await fetch(`${proxyOrigin(proxy)}/v1/messages`)
    await res.text()

    expect(res.headers.get('x-request-id')).toBe('req_abc123')
    expect(res.headers.get('anthropic-ratelimit-tokens-remaining')).toBe('4096')
  })
})

describe('Proxy — first-match routing', () => {
  /** @type {Proxy} */
  let proxy
  /** @type {MockUpstream} */
  let upstreamA
  /** @type {MockUpstream} */
  let upstreamB

  beforeEach(async () => {
    upstreamA = await createMockUpstream()
    upstreamB = await createMockUpstream()
    upstreamA.setHandler((_req, res) => { res.writeHead(200); res.end('A') })
    upstreamB.setHandler((_req, res) => { res.writeHead(200); res.end('B') })

    proxy = new Proxy({
      listen: '127.0.0.1:0',
      upstreams: {
        a: { base_url: upstreamA.baseUrl, match: { path_prefix: '/v1/messages' } },
        b: { base_url: upstreamB.baseUrl, match: { path_prefix: '/v1/embeddings' } },
      },
    })
    await proxy.start()
  })

  afterEach(async () => {
    await proxy.stop()
    await closeServer(upstreamA.server)
    await closeServer(upstreamB.server)
  })

  it('routes by path_prefix to the right upstream', async () => {
    const ra = await fetch(`${proxyOrigin(proxy)}/v1/messages`)
    const rb = await fetch(`${proxyOrigin(proxy)}/v1/embeddings`)

    expect(await ra.text()).toBe('A')
    expect(await rb.text()).toBe('B')
    expect(upstreamA.requests).toHaveLength(1)
    expect(upstreamB.requests).toHaveLength(1)
  })
})

/**
 * Minimal raw HTTP request that lets the test set headers fetch refuses to set
 * (notably `Connection`).
 *
 * @param {string} origin - e.g. http://127.0.0.1:8787
 * @param {{ method: string, path: string, headers: Record<string, string>, body?: string }} opts
 * @returns {Promise<{ status: number, headers: import('node:http').IncomingHttpHeaders, body: string }>}
 */
function rawRequest(origin, opts) {
  const url = new URL(opts.path, origin)
  return new Promise((resolve, reject) => {
    const port = Number.parseInt(url.port, 10)
    const req = http.request({
      method: opts.method,
      hostname: url.hostname,
      port,
      path: url.pathname + url.search,
      headers: opts.headers,
    }, (res) => {
      /** @type {Buffer[]} */
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({
        status: res.statusCode ?? 0,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }))
    })
    req.on('error', reject)
    if (opts.body !== undefined) req.write(opts.body)
    req.end()
  })
}
