import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run } from '../../src/cli.js'
import { ControlPlane } from '../../src/server/control_plane.js'
import { BootstrapStore, signJwt, verifyJwt } from '../../src/server/identity.js'

/**
 * @import { ServerConfig } from '../../src/types.js'
 */

const PLACEHOLDER_SECRET = 'a'.repeat(32)

/** @returns {ServerConfig} */
function serverConfig() {
  return {
    control_plane_listen: '127.0.0.1:0',
    identity_issuer: { secret: PLACEHOLDER_SECRET },
  }
}

/**
 * @param {number} initialMs
 * @returns {{ now: () => number, advance: (ms: number) => void }}
 */
function fakeClock(initialMs) {
  let t = initialMs
  return {
    now: () => t,
    advance: (ms) => { t += ms },
  }
}

function memo() {
  let buf = ''
  return {
    write(/** @type {string} */ s) { buf += s },
    value() { return buf },
  }
}

function noop() {}

/**
 * @param {() => boolean} predicate
 * @param {number} [timeoutMs]
 * @returns {Promise<void>}
 */
async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('ControlPlane class', () => {
  /** @type {ControlPlane} */
  let plane
  /** @type {string} */
  let baseUrl

  beforeEach(async () => {
    plane = new ControlPlane(serverConfig())
    await plane.start()
    const addr = plane.server?.address()
    if (!addr || typeof addr === 'string') throw new Error('no address')
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterEach(async () => {
    await plane.stop()
  })

  it('binds the listener and exposes the assigned port via .server', () => {
    const addr = plane.server?.address()
    if (!addr || typeof addr === 'string') throw new Error('no address')
    expect(addr.port).toBeGreaterThan(0)
    expect(addr.address).toBe('127.0.0.1')
  })

  describe('GET /health (no auth)', () => {
    it('returns 200 with status and version', async () => {
      const res = await fetch(`${baseUrl}/health`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.status).toBe('ok')
      // version comes from package.json — assert shape, not the exact value.
      expect(typeof body.version).toBe('string')
      expect(body.version.length).toBeGreaterThan(0)
    })

    it('does not require an Authorization header', async () => {
      const res = await fetch(`${baseUrl}/health`)
      expect(res.status).toBe(200)
    })

    it('returns 405 on non-GET methods', async () => {
      const res = await fetch(`${baseUrl}/health`, { method: 'POST' })
      expect(res.status).toBe(405)
    })
  })

  describe('POST /v1/identity/bootstrap (no auth)', () => {
    it('returns 503 when no bootstrap store is configured (no body required)', async () => {
      // The default test config omits bootstrap_store_path, so the bootstrap
      // endpoint is intentionally disabled — refresh and ordinary auth still
      // work. handleBootstrap rejects before parsing the body, so an empty
      // POST reaches the 503 branch instead of "empty request body".
      const res = await fetch(`${baseUrl}/v1/identity/bootstrap`, { method: 'POST' })
      expect(res.status).toBe(503)
      const body = await res.json()
      expect(body.error).toBe('bootstrap not provisioned')
    })

    it('returns 405 on non-POST methods', async () => {
      const res = await fetch(`${baseUrl}/v1/identity/bootstrap`)
      expect(res.status).toBe(405)
    })
  })

  describe('POST /v1/identity/refresh (auth required)', () => {
    it('returns 401 when Authorization header is missing', async () => {
      const res = await fetch(`${baseUrl}/v1/identity/refresh`, { method: 'POST' })
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('unauthorized')
    })

    it('returns 401 when Authorization is not a Bearer scheme', async () => {
      const res = await fetch(`${baseUrl}/v1/identity/refresh`, {
        method: 'POST',
        headers: { authorization: 'Basic abcdef' },
      })
      expect(res.status).toBe(401)
    })

    it('returns 401 when Bearer token is empty', async () => {
      const res = await fetch(`${baseUrl}/v1/identity/refresh`, {
        method: 'POST',
        headers: { authorization: 'Bearer    ' },
      })
      expect(res.status).toBe(401)
    })

    it('returns 401 when Bearer token is not a valid JWT', async () => {
      // A.3 verifies the JWT — a non-JWT bearer string can no longer reach
      // the handler. Detailed JWT-shape coverage lives in auth.test.js.
      const res = await fetch(`${baseUrl}/v1/identity/refresh`, {
        method: 'POST',
        headers: { authorization: 'Bearer placeholder-token' },
      })
      expect(res.status).toBe(401)
      const body = await res.json()
      expect(body.error).toBe('unauthorized')
    })

    it('returns 405 on non-POST methods', async () => {
      const res = await fetch(`${baseUrl}/v1/identity/refresh`)
      expect(res.status).toBe(405)
    })
  })

  it('returns 404 for unknown paths', async () => {
    const res = await fetch(`${baseUrl}/anything-else`)
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('not found')
  })

  it('rejects invalid listen addresses at construction', () => {
    expect(() => new ControlPlane({
      control_plane_listen: 'not-a-host-port',
      identity_issuer: { secret: PLACEHOLDER_SECRET },
    })).toThrow(/invalid listen address/)
  })

  it('stop() is idempotent — calling twice does not reject', async () => {
    await plane.stop()
    await plane.stop()
  })
})

describe('Identity flow end-to-end (HTTP)', () => {
  /** @type {string} */
  let dir
  /** @type {ControlPlane | undefined} */
  let plane
  /** @type {string} */
  let baseUrl

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-cp-id-'))
  })
  afterEach(async () => {
    if (plane) await plane.stop()
    plane = undefined
    fs.rmSync(dir, { recursive: true, force: true })
  })

  /**
   * Spin up a control plane backed by a real BootstrapStore at `dir`.
   *
   * @param {{ clock?: { now: () => number } }} [opts]
   * @returns {Promise<{ store: BootstrapStore, plane: ControlPlane }>}
   */
  async function bootPlane(opts = {}) {
    const storePath = path.join(dir, 'bootstrap.json')
    const store = new BootstrapStore({ path: storePath, now: opts.clock?.now })
    plane = new ControlPlane(
      {
        control_plane_listen: '127.0.0.1:0',
        identity_issuer: { secret: PLACEHOLDER_SECRET, bootstrap_store_path: storePath },
      },
      { bootstrapStore: store, now: opts.clock?.now }
    )
    await plane.start()
    const addr = plane.server?.address()
    if (!addr || typeof addr === 'string') throw new Error('no address')
    baseUrl = `http://127.0.0.1:${addr.port}`
    return { store, plane }
  }

  it('exchanges a bootstrap token for a usable JWT exactly once', async () => {
    const { store } = await bootPlane()
    const { token } = store.register({ gatewayId: 'gw-1', ttlSeconds: 60 })

    const ok = await fetch(`${baseUrl}/v1/identity/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bootstrap_token: token }),
    })
    expect(ok.status).toBe(200)
    const body = await ok.json()
    expect(typeof body.jwt).toBe('string')
    expect(typeof body.expires_at).toBe('number')

    const verified = verifyJwt(body.jwt, PLACEHOLDER_SECRET)
    expect(verified.valid).toBe(true)
    if (!verified.valid) throw new Error('unreachable')
    expect(verified.claims.sub).toBe('gw-1')

    // Replay must fail with 401.
    const replay = await fetch(`${baseUrl}/v1/identity/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bootstrap_token: token }),
    })
    expect(replay.status).toBe(401)
  })

  it('rejects bootstrap requests with a missing/invalid body', async () => {
    await bootPlane()
    const empty = await fetch(`${baseUrl}/v1/identity/bootstrap`, { method: 'POST' })
    expect(empty.status).toBe(400)

    const bad = await fetch(`${baseUrl}/v1/identity/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not-json',
    })
    expect(bad.status).toBe(400)

    const wrongShape = await fetch(`${baseUrl}/v1/identity/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wrong: 'field' }),
    })
    expect(wrongShape.status).toBe(400)
  })

  it('rejects unknown bootstrap tokens with 401', async () => {
    await bootPlane()
    const res = await fetch(`${baseUrl}/v1/identity/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bootstrap_token: 'not-a-real-token' }),
    })
    expect(res.status).toBe(401)
  })

  it('refresh issues a new JWT for an authenticated gateway', async () => {
    await bootPlane()
    const jwt = signJwt({ gatewayId: 'gw-7', ttlSeconds: 60, secret: PLACEHOLDER_SECRET })
    const res = await fetch(`${baseUrl}/v1/identity/refresh`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body.jwt).toBe('string')
    expect(body.jwt).not.toBe(jwt)
    const verified = verifyJwt(body.jwt, PLACEHOLDER_SECRET)
    expect(verified.valid).toBe(true)
    if (!verified.valid) throw new Error('unreachable')
    expect(verified.claims.sub).toBe('gw-7')
  })

  it('rejects refresh with an expired JWT', async () => {
    const clock = fakeClock(1_700_000_000_000)
    await bootPlane({ clock })
    const jwt = signJwt({ gatewayId: 'gw', ttlSeconds: 60, secret: PLACEHOLDER_SECRET, now: clock.now })
    clock.advance(61_000)
    const res = await fetch(`${baseUrl}/v1/identity/refresh`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(res.status).toBe(401)
  })

  it('rate-limits bootstrap to 5 requests/min/IP', async () => {
    const clock = fakeClock(1_700_000_000_000)
    await bootPlane({ clock })
    // 5 requests with bogus tokens — each is 401 but counts toward the limit.
    for (let i = 0; i < 5; i++) {
      const r = await fetch(`${baseUrl}/v1/identity/bootstrap`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ bootstrap_token: 'nope' }),
      })
      expect(r.status).toBe(401)
    }
    // The 6th in the same window must be 429.
    const limited = await fetch(`${baseUrl}/v1/identity/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bootstrap_token: 'nope' }),
    })
    expect(limited.status).toBe(429)
    expect(limited.headers.get('retry-after')).toMatch(/^\d+$/)
  })

  it('rate-limits refresh to 1 request/min/gateway', async () => {
    const clock = fakeClock(1_700_000_000_000)
    await bootPlane({ clock })
    const jwt = signJwt({ gatewayId: 'gw', ttlSeconds: 600, secret: PLACEHOLDER_SECRET, now: clock.now })
    const first = await fetch(`${baseUrl}/v1/identity/refresh`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(first.status).toBe(200)

    const second = await fetch(`${baseUrl}/v1/identity/refresh`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(second.status).toBe(429)

    // Move the clock past the window — refresh works again.
    clock.advance(60_001)
    const third = await fetch(`${baseUrl}/v1/identity/refresh`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}` },
    })
    expect(third.status).toBe(200)
  })

  it('rejects bootstrap bodies larger than 4KiB', async () => {
    await bootPlane()
    const big = 'x'.repeat(5 * 1024)
    const res = await fetch(`${baseUrl}/v1/identity/bootstrap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bootstrap_token: big }),
    })
    expect(res.status).toBe(413)
  })
})

describe('CLI lifecycle wiring', () => {
  /** @type {string} */
  let tmpDir
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-cp-cli-'))
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  /**
   * @param {object} cfg
   * @returns {string}
   */
  function writeConfig(cfg) {
    const p = path.join(tmpDir, 'config.json')
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2))
    return p
  }

  it('role: server starts the control-plane listener and exits cleanly on shutdown', async () => {
    const cfgPath = writeConfig({
      version: 1,
      role: 'server',
      server: {
        control_plane_listen: '127.0.0.1:0',
        identity_issuer: { secret: PLACEHOLDER_SECRET },
      },
    })
    const stdout = memo()
    const stderr = memo()
    /** @type {(signal: string) => void} */
    let trigger = noop
    const result = run(['--config', cfgPath], {}, {
      stdout, stderr,
      onShutdownRequested: (handler) => { trigger = handler },
    })
    await waitFor(() => stdout.value().includes('Control-plane listener bound'))
    trigger('SIGTERM')
    expect(await result).toBe(0)
    expect(stdout.value()).toMatch(/Control-plane listener bound on 127\.0\.0\.1:\d+/)
    expect(stdout.value()).toMatch(/Received SIGTERM/)
    expect(stdout.value()).toMatch(/Shutdown complete/)
  })

  it('role: standalone does NOT start the control-plane listener', async () => {
    const cfgPath = writeConfig({
      version: 1,
      otel: { listen: '127.0.0.1:0' },
      sink: { type: 'file', dir: path.join(tmpDir, 'data') },
    })
    const stdout = memo()
    const stderr = memo()
    /** @type {(signal: string) => void} */
    let trigger = noop
    const result = run(['--config', cfgPath], {}, {
      stdout, stderr,
      onShutdownRequested: (handler) => { trigger = handler },
    })
    await waitFor(() => stdout.value().includes('OTLP listener bound'))
    trigger('SIGTERM')
    expect(await result).toBe(0)
    expect(stdout.value()).not.toMatch(/Control-plane listener bound/)
  })

  it('role: gateway does NOT start the control-plane listener', async () => {
    // Gateway needs at least one bound listener (otel/proxy) — A.4 wires the
    // gateway-side bootstrap client. For now, pair with otel so the lifecycle
    // has something to keep alive while we assert the control plane is absent.
    const cfgPath = writeConfig({
      version: 1,
      role: 'gateway',
      otel: { listen: '127.0.0.1:0' },
      sink: { type: 'file', dir: path.join(tmpDir, 'data') },
      central_server: {
        url: 'http://127.0.0.1:1',
        identity: { bootstrap_token: 'placeholder-bootstrap-token' },
      },
    })
    const stdout = memo()
    const stderr = memo()
    /** @type {(signal: string) => void} */
    let trigger = noop
    const result = run(['--config', cfgPath], {}, {
      stdout, stderr,
      onShutdownRequested: (handler) => { trigger = handler },
    })
    await waitFor(() => stdout.value().includes('OTLP listener bound'))
    trigger('SIGTERM')
    expect(await result).toBe(0)
    expect(stdout.value()).not.toMatch(/Control-plane listener bound/)
  })

  it('drains the control plane via stopAll within DRAIN_TIMEOUT_MS', async () => {
    const cfgPath = writeConfig({
      version: 1,
      role: 'server',
      server: {
        control_plane_listen: '127.0.0.1:0',
        identity_issuer: { secret: PLACEHOLDER_SECRET },
      },
    })
    const stdout = memo()
    const stderr = memo()
    /** @type {(signal: string) => void} */
    let trigger = noop
    const result = run(['--config', cfgPath], {}, {
      stdout, stderr,
      onShutdownRequested: (handler) => { trigger = handler },
    })
    await waitFor(() => stdout.value().includes('Control-plane listener bound'))
    const drainStart = Date.now()
    trigger('SIGTERM')
    const code = await result
    const drainMs = Date.now() - drainStart
    expect(code).toBe(0)
    expect(drainMs).toBeLessThan(5000)
    // No drain-timeout warning.
    expect(stderr.value()).not.toMatch(/drain exceeded/)
  })
})
