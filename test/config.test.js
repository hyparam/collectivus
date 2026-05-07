import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ConfigError, loadConfig } from '../src/config.js'

/** @type {string} */
let tmpDir

beforeEach(function() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-config-'))
})

afterEach(function() {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/**
 * @param {string} name
 * @param {string} body
 * @returns {string}
 */
function writeFile(name, body) {
  const p = path.join(tmpDir, name)
  fs.writeFileSync(p, body)
  return p
}

/**
 * @param {string} name
 * @param {unknown} obj
 * @returns {string}
 */
function writeJson(name, obj) {
  return writeFile(name, JSON.stringify(obj, null, 2))
}

describe('loadConfig - file errors', () => {
  it('throws ConfigError when the file does not exist', () => {
    const missing = path.join(tmpDir, 'does-not-exist.json')
    expect(() => loadConfig(missing)).toThrow(ConfigError)
    expect(() => loadConfig(missing)).toThrow(/config file not found/)
  })
})

describe('loadConfig - JSON errors', () => {
  it('throws ConfigError with line/column for invalid JSON', () => {
    const p = writeFile('bad.json', '{\n  "otel": {\n    "listen": 4318,\n  }\n}')
    /** @type {unknown} */
    let caught
    try {
      loadConfig(p)
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(ConfigError)
    const msg = caught instanceof Error ? caught.message : String(caught)
    expect(msg).toMatch(/invalid JSON/)
    expect(msg).toMatch(/line \d+, column \d+/)
  })

  it('rejects an empty file', () => {
    const p = writeFile('empty.json', '')
    expect(() => loadConfig(p)).toThrow(ConfigError)
  })
})

describe('loadConfig - schema errors', () => {
  it('rejects a non-object root', () => {
    const p = writeJson('arr.json', ['otel'])
    expect(() => loadConfig(p)).toThrow(/must be an object/)
  })

  it('rejects unknown top-level keys', () => {
    const p = writeJson('extra.json', { otel: { listen: '0.0.0.0:4318' }, mystery: 1 })
    expect(() => loadConfig(p)).toThrow(/unknown key "mystery"/)
  })

  it('requires sink when proxy is present', () => {
    const p = writeJson('no-sink.json', {
      proxy: {
        listen: '0.0.0.0:8080',
        upstreams: {
          a: { base_url: 'https://api.anthropic.com', match: { path_prefix: '/v1/messages' } },
        },
      },
    })
    expect(() => loadConfig(p)).toThrow(/sink is required when proxy is configured/)
  })

  it('rejects proxy without upstreams', () => {
    const p = writeJson('no-upstreams.json', {
      proxy: { listen: '0.0.0.0:8080' },
      sink: { type: 'file', dir: '/tmp' },
    })
    expect(() => loadConfig(p)).toThrow(/upstreams is required/)
  })

  it('rejects empty upstreams object', () => {
    const p = writeJson('empty-upstreams.json', {
      proxy: { listen: '0.0.0.0:8080', upstreams: {} },
      sink: { type: 'file', dir: '/tmp' },
    })
    expect(() => loadConfig(p)).toThrow(/at least one upstream is required/)
  })

  it('rejects upstream missing base_url', () => {
    const p = writeJson('bad-upstream.json', {
      proxy: {
        listen: '0.0.0.0:8080',
        upstreams: { a: { match: { path_prefix: '/x' } } },
      },
      sink: { type: 'file', dir: '/tmp' },
    })
    expect(() => loadConfig(p)).toThrow(/\/proxy\/upstreams\/a\/base_url/)
  })

  it('rejects upstream missing match.path_prefix', () => {
    const p = writeJson('bad-match.json', {
      proxy: {
        listen: '0.0.0.0:8080',
        upstreams: { a: { base_url: 'https://x.test', match: {} } },
      },
      sink: { type: 'file', dir: '/tmp' },
    })
    expect(() => loadConfig(p)).toThrow(/path_prefix/)
  })

  it('rejects sink type other than "file"', () => {
    const p = writeJson('bad-sink.json', {
      sink: { type: 's3', dir: '/tmp' },
    })
    expect(() => loadConfig(p)).toThrow(/only sink type "file" is supported in v0/)
  })

  it('rejects otel.listen that is not a string', () => {
    const p = writeJson('bad-otel.json', { otel: { listen: 4318 } })
    expect(() => loadConfig(p)).toThrow(/\/otel\/listen/)
  })

  it('rejects redact_headers that is not an array', () => {
    const p = writeJson('bad-redact.json', {
      proxy: {
        listen: '0.0.0.0:8080',
        redact_headers: 'authorization',
        upstreams: {
          a: { base_url: 'https://x.test', match: { path_prefix: '/x' } },
        },
      },
      sink: { type: 'file', dir: '/tmp' },
    })
    expect(() => loadConfig(p)).toThrow(/redact_headers/)
  })
})

describe('loadConfig - valid configs', () => {
  it('loads an otel-only config', () => {
    const p = writeJson('otel.json', { otel: { listen: '0.0.0.0:4318' } })
    expect(loadConfig(p)).toEqual({ otel: { listen: '0.0.0.0:4318' } })
  })

  it('loads a proxy-only config (with required sink)', () => {
    const cfg = {
      proxy: {
        listen: '0.0.0.0:8080',
        upstreams: {
          anthropic: {
            base_url: 'https://api.anthropic.com',
            match: { path_prefix: '/v1/messages' },
          },
        },
      },
      sink: { type: 'file', dir: '/var/log/collectivus' },
    }
    const p = writeJson('proxy.json', cfg)
    expect(loadConfig(p)).toEqual(cfg)
  })

  it('loads a config with both otel and proxy', () => {
    const cfg = {
      otel: { listen: '0.0.0.0:4318' },
      proxy: {
        listen: '0.0.0.0:8080',
        redact_headers: ['authorization', 'x-api-key'],
        upstreams: {
          anthropic: {
            base_url: 'https://api.anthropic.com',
            match: { path_prefix: '/v1/messages' },
          },
          openai: {
            base_url: 'https://api.openai.com',
            match: { path_prefix: '/v1/chat' },
          },
        },
      },
      sink: { type: 'file', dir: '/var/log/collectivus' },
    }
    const p = writeJson('both.json', cfg)
    expect(loadConfig(p)).toEqual(cfg)
  })

  it('accepts an empty config object (every section is optional)', () => {
    const p = writeJson('empty.json', {})
    expect(loadConfig(p)).toEqual({})
  })
})
