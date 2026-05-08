import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { run } from '../../src/cli.js'
import { ControlPlane } from '../../src/server/control_plane.js'

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
    it('returns 501 placeholder without requiring Authorization', async () => {
      const res = await fetch(`${baseUrl}/v1/identity/bootstrap`, { method: 'POST' })
      expect(res.status).toBe(501)
      const body = await res.json()
      expect(body.error).toBe('not implemented')
      expect(body.endpoint).toBe('bootstrap')
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

    it('returns 501 placeholder when Bearer token is present (A.3 will verify)', async () => {
      const res = await fetch(`${baseUrl}/v1/identity/refresh`, {
        method: 'POST',
        headers: { authorization: 'Bearer placeholder-token' },
      })
      expect(res.status).toBe(501)
      const body = await res.json()
      expect(body.error).toBe('not implemented')
      expect(body.endpoint).toBe('refresh')
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
