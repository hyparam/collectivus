import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  ConfigRegistry,
  canonicalJsonString,
  computeEtag,
  defaultServerDataDir,
  resolveConfigsDir,
} from '../../src/server/config_registry.js'

/**
 * @import { CollectivusConfig } from '../../src/types.js'
 */

/**
 * Build a minimal valid gateway config. The gateway-side validator requires
 * `version: 1`, and (for role: 'gateway') a `central_server` block with the
 * identity sub-block. Pair with a sink/otel so the test config survives any
 * subsequent role-vs-sink cross-checks the validator may grow.
 *
 * @param {{ url?: string, sinkDir?: string }} [opts]
 * @returns {CollectivusConfig}
 */
function gatewayCfg(opts = {}) {
  return {
    version: 1,
    role: 'gateway',
    otel: { listen: '127.0.0.1:0' },
    sink: { type: 'file', dir: opts.sinkDir ?? '/tmp/cfg-test-sink' },
    central_server: {
      url: opts.url ?? 'https://control.example.com:8788',
      identity: {
        bootstrap_token: 'placeholder-bootstrap-token',
      },
    },
  }
}

describe('defaultServerDataDir', () => {
  it('resolves under the supplied home directory', () => {
    expect(defaultServerDataDir('/tmp/fake-home')).toBe('/tmp/fake-home/.hyp/collectivus/server-data')
  })

  it('falls back to os.homedir() when no override is provided', () => {
    expect(defaultServerDataDir()).toBe(path.join(os.homedir(), '.hyp', 'collectivus', 'server-data'))
  })
})

describe('resolveConfigsDir', () => {
  it('uses ServerConfig.data_dir + /configs when set', () => {
    const dir = resolveConfigsDir({
      control_plane_listen: '127.0.0.1:0',
      identity_issuer: { secret: 'a'.repeat(32) },
      data_dir: '/var/lib/collectivus',
    })
    expect(dir).toBe('/var/lib/collectivus/configs')
  })

  it('defaults to ~/.hyp/collectivus/server-data/configs when data_dir is absent', () => {
    const dir = resolveConfigsDir({
      control_plane_listen: '127.0.0.1:0',
      identity_issuer: { secret: 'a'.repeat(32) },
    }, { homeDir: '/tmp/fake-home' })
    expect(dir).toBe('/tmp/fake-home/.hyp/collectivus/server-data/configs')
  })
})

describe('canonicalJsonString', () => {
  it('sorts keys lexicographically at every depth', () => {
    const a = { b: 2, a: { z: 1, m: 2 }, c: 3 }
    const b = { c: 3, a: { m: 2, z: 1 }, b: 2 }
    expect(canonicalJsonString(a)).toBe(canonicalJsonString(b))
    expect(canonicalJsonString(a)).toBe('{"a":{"m":2,"z":1},"b":2,"c":3}')
  })

  it('preserves array order', () => {
    expect(canonicalJsonString({ x: [3, 1, 2] })).toBe('{"x":[3,1,2]}')
  })

  it('throws on non-finite numbers', () => {
    expect(() => canonicalJsonString({ n: Number.NaN })).toThrow(/non-finite/)
    expect(() => canonicalJsonString({ n: Number.POSITIVE_INFINITY })).toThrow(/non-finite/)
  })

  it('throws on values JSON would silently drop', () => {
    expect(() => canonicalJsonString({ fn: () => 1 })).toThrow(/unsupported/)
  })
})

describe('computeEtag', () => {
  it('is deterministic across key-order permutations', () => {
    const a = computeEtag(gatewayCfg({ url: 'https://a.example.com' }))
    const b = computeEtag({
      central_server: {
        identity: { bootstrap_token: 'placeholder-bootstrap-token' },
        url: 'https://a.example.com',
      },
      role: 'gateway',
      sink: { dir: '/tmp/cfg-test-sink', type: 'file' },
      otel: { listen: '127.0.0.1:0' },
      version: 1,
    })
    expect(a).toBe(b)
  })

  it('changes when the config changes', () => {
    const a = computeEtag(gatewayCfg({ url: 'https://a.example.com' }))
    const b = computeEtag(gatewayCfg({ url: 'https://b.example.com' }))
    expect(a).not.toBe(b)
  })

  it('returns a 64-char hex string (sha256)', () => {
    const e = computeEtag(gatewayCfg())
    expect(e).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('ConfigRegistry', () => {
  /** @type {string} */
  let dir
  /** @type {ConfigRegistry} */
  let registry

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-cfg-reg-'))
    registry = new ConfigRegistry({ configsDir: path.join(dir, 'configs') })
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('rejects construction without a configsDir', () => {
    // @ts-expect-error - testing the runtime guard
    expect(() => new ConfigRegistry({})).toThrow(/configsDir is required/)
    expect(() => new ConfigRegistry({ configsDir: '' })).toThrow(/configsDir is required/)
  })

  it('getConfig returns undefined when no config is registered', () => {
    expect(registry.getConfig('gw-1')).toBeUndefined()
  })

  it('setConfig + getConfig roundtrips a valid gateway config with a stable ETag', () => {
    const cfg = gatewayCfg()
    const { etag } = registry.setConfig('gw-1', cfg)
    expect(etag).toMatch(/^[0-9a-f]{64}$/)

    const entry = registry.getConfig('gw-1')
    if (!entry) throw new Error('expected entry')
    expect(entry.config).toEqual(cfg)
    expect(entry.etag).toBe(etag)
  })

  it('setConfig rejects a config that fails the gateway-side validator', () => {
    expect(() => registry.setConfig('gw-1', { version: 0 })).toThrow(/version/)
    expect(() => registry.setConfig('gw-1', { version: 1, role: 'gateway' })).toThrow(/central_server/)
    expect(() => registry.setConfig('gw-1', null)).toThrow(/object/)
  })

  it('setConfig writes atomically (no .tmp file remains after success)', () => {
    registry.setConfig('gw-1', gatewayCfg())
    const files = fs.readdirSync(path.join(dir, 'configs'))
    const tmps = files.filter((f) => f.includes('.tmp.'))
    expect(tmps).toEqual([])
    expect(files).toContain('gw-1.json')
  })

  it('setConfig persists canonical JSON whose sha256 matches the returned ETag byte-for-byte', () => {
    const { etag } = registry.setConfig('gw-1', gatewayCfg())
    const file = path.join(dir, 'configs', 'gw-1.json')
    const raw = fs.readFileSync(file, 'utf8')
    const onDiskHash = crypto.createHash('sha256').update(raw, 'utf8').digest('hex')
    expect(onDiskHash).toBe(etag)
  })

  it('setConfig overwrites an existing config and returns the new ETag', () => {
    const { etag: etagA } = registry.setConfig('gw-1', gatewayCfg({ url: 'https://a.example.com' }))
    const { etag: etagB } = registry.setConfig('gw-1', gatewayCfg({ url: 'https://b.example.com' }))
    expect(etagA).not.toBe(etagB)

    const entry = registry.getConfig('gw-1')
    if (!entry) throw new Error('expected entry')
    expect(entry.etag).toBe(etagB)
  })

  it('listGateways returns sorted IDs and ignores non-JSON files', () => {
    registry.setConfig('gw-c', gatewayCfg())
    registry.setConfig('gw-a', gatewayCfg())
    registry.setConfig('gw-b', gatewayCfg())
    fs.writeFileSync(path.join(dir, 'configs', 'README.md'), 'not a config')
    fs.writeFileSync(path.join(dir, 'configs', '.hidden.json'), '{}')
    fs.writeFileSync(path.join(dir, 'configs', 'gw-x.json.tmp.123'), 'partial')

    // `.hidden.json` is filtered: gateway IDs must start with an alphanumeric,
    // so dot-prefixed filenames are not surfaced even if they parse as JSON.
    expect(registry.listGateways()).toEqual(['gw-a', 'gw-b', 'gw-c'])
  })

  it('listGateways returns [] when the configsDir does not exist', () => {
    const fresh = new ConfigRegistry({ configsDir: path.join(dir, 'never-created') })
    expect(fresh.listGateways()).toEqual([])
  })

  it('deleteConfig returns true on existing, false on missing', () => {
    registry.setConfig('gw-1', gatewayCfg())
    expect(registry.deleteConfig('gw-1')).toBe(true)
    expect(registry.getConfig('gw-1')).toBeUndefined()
    expect(registry.deleteConfig('gw-1')).toBe(false)
  })

  it('rejects gatewayIds that contain path-traversal characters', () => {
    expect(() => registry.setConfig('../etc/passwd', gatewayCfg())).toThrow(/invalid gatewayId/)
    expect(() => registry.getConfig('../etc/passwd')).toThrow(/invalid gatewayId/)
    expect(() => registry.setConfig('gw/with/slash', gatewayCfg())).toThrow(/invalid gatewayId/)
    expect(() => registry.setConfig('', gatewayCfg())).toThrow(/gatewayId is required/)
    expect(() => registry.setConfig('.', gatewayCfg())).toThrow(/invalid gatewayId/)
    expect(() => registry.setConfig('..', gatewayCfg())).toThrow(/invalid gatewayId/)
    expect(() => registry.setConfig('.hidden', gatewayCfg())).toThrow(/invalid gatewayId/)
  })

  it('accepts email-shaped gatewayIds', () => {
    registry.setConfig('james.smith@acme.com', gatewayCfg())
    expect(registry.getConfig('james.smith@acme.com')).toBeDefined()
    registry.setConfig('alice+work@example.co.uk', gatewayCfg())
    expect(registry.getConfig('alice+work@example.co.uk')).toBeDefined()
  })

  it('getConfig surfaces invalid JSON from disk as a thrown error', () => {
    fs.mkdirSync(path.join(dir, 'configs'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'configs', 'gw-1.json'), '{not json')
    expect(() => registry.getConfig('gw-1')).toThrow(/invalid JSON/)
  })

  it('getConfig surfaces a config that no longer satisfies the validator', () => {
    fs.mkdirSync(path.join(dir, 'configs'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'configs', 'gw-1.json'), JSON.stringify({ version: 999 }))
    expect(() => registry.getConfig('gw-1')).toThrow(/version/)
  })

  it('isolates configs across gateways (B cannot see A by name)', () => {
    registry.setConfig('gw-a', gatewayCfg({ url: 'https://a.example.com' }))
    registry.setConfig('gw-b', gatewayCfg({ url: 'https://b.example.com' }))
    const a = registry.getConfig('gw-a')
    const b = registry.getConfig('gw-b')
    if (!a || !b) throw new Error('expected entries')
    expect(a.config.central_server?.url).toBe('https://a.example.com')
    expect(b.config.central_server?.url).toBe('https://b.example.com')
    expect(a.etag).not.toBe(b.etag)
  })
})
