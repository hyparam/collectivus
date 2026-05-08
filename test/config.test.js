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

/**
 * Tests use the no-op stderr to avoid leaking warnings into the test runner
 * output for cases where strict-mode warnings aren't the assertion target.
 *
 * @returns {{ write: (s: string) => void, value: () => string }}
 */
function memoStderr() {
  let buf = ''
  return { write(s) { buf += s }, value() { return buf } }
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

describe('loadConfig - version', () => {
  it('hard-fails a v0 config (no version field) with the documented error', () => {
    const p = writeJson('v0.json', { otel: { listen: '0.0.0.0:4318' }, sink: { type: 'file', dir: '/tmp' } })
    expect(() => loadConfig(p)).toThrow(/missing "version" field/)
    expect(() => loadConfig(p)).toThrow(/requires version: 1/)
  })

  it('rejects an unsupported version value', () => {
    const p = writeJson('v2.json', { version: 2 })
    expect(() => loadConfig(p)).toThrow(/unsupported version/)
  })

  it('rejects a string version', () => {
    const p = writeJson('vstr.json', { version: '1' })
    expect(() => loadConfig(p)).toThrow(/unsupported version/)
  })

  it('accepts version: 1', () => {
    const p = writeJson('v1.json', { version: 1 })
    expect(loadConfig(p)).toEqual({ version: 1 })
  })
})

describe('loadConfig - schema errors', () => {
  it('rejects a non-object root', () => {
    const p = writeJson('arr.json', ['otel'])
    expect(() => loadConfig(p)).toThrow(/must be an object/)
  })

  it('warns on unknown top-level keys without --strict', () => {
    const p = writeJson('extra.json', {
      version: 1,
      otel: { listen: '0.0.0.0:4318' },
      sink: { type: 'file', dir: '/tmp' },
      mystery: 1,
    })
    const stderr = memoStderr()
    const cfg = loadConfig(p, { stderr })
    // Unknown key is ignored, not stripped (validator does not mutate).
    expect(cfg).toEqual({
      version: 1,
      otel: { listen: '0.0.0.0:4318' },
      sink: { type: 'file', dir: '/tmp' },
      mystery: 1,
    })
    expect(stderr.value()).toMatch(/unknown config key "mystery" ignored/)
    expect(stderr.value()).toMatch(/recognizes:.*"version".*"otel".*"proxy".*"sink".*"upload"/)
  })

  it('rejects unknown top-level keys with --strict', () => {
    const p = writeJson('extra.json', {
      version: 1,
      otel: { listen: '0.0.0.0:4318' },
      sink: { type: 'file', dir: '/tmp' },
      mystery: 1,
    })
    expect(() => loadConfig(p, { strict: true })).toThrow(/unknown key "mystery"/)
  })

  it('rejects per-section unknown keys regardless of strict', () => {
    const p = writeJson('typo.json', {
      version: 1,
      proxy: {
        listen: '0.0.0.0:8080',
        // typo: upsteams instead of upstreams
        upsteams: [],
      },
      sink: { type: 'file', dir: '/tmp' },
    })
    // Without --strict, per-section unknown keys still fail.
    expect(() => loadConfig(p, { stderr: memoStderr() })).toThrow(/unknown key "upsteams"/)
  })

  it('requires sink when proxy is present', () => {
    const p = writeJson('no-sink.json', {
      version: 1,
      proxy: {
        listen: '0.0.0.0:8080',
        upstreams: [
          { name: 'a', base_url: 'https://api.anthropic.com', match: { path_prefix: '/v1/messages' } },
        ],
      },
    })
    expect(() => loadConfig(p)).toThrow(/sink is required when otel or proxy is configured/)
  })

  it('requires sink when otel is present', () => {
    const p = writeJson('otel-no-sink.json', {
      version: 1,
      otel: { listen: '0.0.0.0:4318' },
    })
    expect(() => loadConfig(p)).toThrow(/sink is required when otel or proxy is configured/)
  })

  it('rejects proxy without upstreams', () => {
    const p = writeJson('no-upstreams.json', {
      version: 1,
      proxy: { listen: '0.0.0.0:8080' },
      sink: { type: 'file', dir: '/tmp' },
    })
    expect(() => loadConfig(p)).toThrow(/upstreams is required/)
  })

  it('rejects upstreams that is not an array', () => {
    const p = writeJson('object-upstreams.json', {
      version: 1,
      proxy: {
        listen: '0.0.0.0:8080',
        // The v0 object-map shape is no longer valid.
        upstreams: { a: { base_url: 'https://x.test', match: { path_prefix: '/' } } },
      },
      sink: { type: 'file', dir: '/tmp' },
    })
    expect(() => loadConfig(p)).toThrow(/\/proxy\/upstreams.*must be an array/)
  })

  it('rejects empty upstreams array', () => {
    const p = writeJson('empty-upstreams.json', {
      version: 1,
      proxy: { listen: '0.0.0.0:8080', upstreams: [] },
      sink: { type: 'file', dir: '/tmp' },
    })
    expect(() => loadConfig(p)).toThrow(/at least one upstream is required/)
  })

  it('rejects upstream missing name', () => {
    const p = writeJson('no-name.json', {
      version: 1,
      proxy: {
        listen: '0.0.0.0:8080',
        upstreams: [{ base_url: 'https://x.test', match: { path_prefix: '/x' } }],
      },
      sink: { type: 'file', dir: '/tmp' },
    })
    expect(() => loadConfig(p)).toThrow(/\/proxy\/upstreams\/0\/name/)
  })

  it('rejects upstream missing base_url', () => {
    const p = writeJson('bad-upstream.json', {
      version: 1,
      proxy: {
        listen: '0.0.0.0:8080',
        upstreams: [{ name: 'a', match: { path_prefix: '/x' } }],
      },
      sink: { type: 'file', dir: '/tmp' },
    })
    expect(() => loadConfig(p)).toThrow(/\/proxy\/upstreams\/0\/base_url/)
  })

  it('rejects upstream missing match.path_prefix', () => {
    const p = writeJson('bad-match.json', {
      version: 1,
      proxy: {
        listen: '0.0.0.0:8080',
        upstreams: [{ name: 'a', base_url: 'https://x.test', match: {} }],
      },
      sink: { type: 'file', dir: '/tmp' },
    })
    expect(() => loadConfig(p)).toThrow(/path_prefix/)
  })

  it('rejects duplicate upstream names', () => {
    const p = writeJson('dup-name.json', {
      version: 1,
      proxy: {
        listen: '0.0.0.0:8080',
        upstreams: [
          { name: 'dup', base_url: 'https://a.test', match: { path_prefix: '/a' } },
          { name: 'dup', base_url: 'https://b.test', match: { path_prefix: '/b' } },
        ],
      },
      sink: { type: 'file', dir: '/tmp' },
    })
    expect(() => loadConfig(p)).toThrow(/duplicate upstream name "dup"/)
  })

  it('rejects sink type other than "file"', () => {
    const p = writeJson('bad-sink.json', {
      version: 1,
      sink: { type: 's3', dir: '/tmp' },
    })
    expect(() => loadConfig(p)).toThrow(/only sink type "file" is supported in v0/)
  })

  it('rejects otel.listen that is not a string', () => {
    const p = writeJson('bad-otel.json', {
      version: 1,
      otel: { listen: 4318 },
      sink: { type: 'file', dir: '/tmp' },
    })
    expect(() => loadConfig(p)).toThrow(/\/otel\/listen/)
  })

  it('rejects redact_headers that is not an array', () => {
    const p = writeJson('bad-redact.json', {
      version: 1,
      proxy: {
        listen: '0.0.0.0:8080',
        redact_headers: 'authorization',
        upstreams: [
          { name: 'a', base_url: 'https://x.test', match: { path_prefix: '/x' } },
        ],
      },
      sink: { type: 'file', dir: '/tmp' },
    })
    expect(() => loadConfig(p)).toThrow(/redact_headers/)
  })
})

describe('loadConfig - upload section', () => {
  it('accepts a minimal upload block (only bucket)', () => {
    const cfg = { version: 1, upload: { bucket: 'my-bucket' } }
    const p = writeJson('upload-min.json', cfg)
    expect(loadConfig(p)).toEqual(cfg)
  })

  it('accepts a fully populated upload block', () => {
    const cfg = {
      version: 1,
      upload: {
        bucket: 'my-bucket',
        prefix: 'logs',
        region: 'us-west-2',
        time: '02:30',
        signals: ['logs', 'traces'],
        catchupDays: 7,
        endpoint: 'http://minio:9000',
      },
    }
    const p = writeJson('upload-full.json', cfg)
    expect(loadConfig(p)).toEqual(cfg)
  })

  it('does not inject defaults — print-config round-trips unchanged', () => {
    // The validator must not mutate the parsed object; defaults are applied
    // later by createUploader. This guarantees `--print-config` shows what
    // the user wrote, not what the binary will run with.
    const cfg = { version: 1, upload: { bucket: 'b' } }
    const p = writeJson('upload-no-defaults.json', cfg)
    const loaded = loadConfig(p)
    expect(loaded.upload).toEqual({ bucket: 'b' })
    expect(/** @type {any} */ (loaded.upload).prefix).toBeUndefined()
    expect(/** @type {any} */ (loaded.upload).time).toBeUndefined()
  })

  it('rejects upload missing bucket', () => {
    const p = writeJson('no-bucket.json', { version: 1, upload: { prefix: 'logs' } })
    expect(() => loadConfig(p)).toThrow(/\/upload\/bucket/)
  })

  it('rejects empty bucket', () => {
    const p = writeJson('empty-bucket.json', { version: 1, upload: { bucket: '' } })
    expect(() => loadConfig(p)).toThrow(/\/upload\/bucket/)
  })

  it('rejects malformed time', () => {
    const p = writeJson('bad-time.json', {
      version: 1,
      upload: { bucket: 'b', time: '24:00' },
    })
    expect(() => loadConfig(p)).toThrow(/\/upload\/time.*HH:MM/)
  })

  it('rejects time without colon', () => {
    const p = writeJson('bad-time2.json', {
      version: 1,
      upload: { bucket: 'b', time: '0010' },
    })
    expect(() => loadConfig(p)).toThrow(/\/upload\/time/)
  })

  it('rejects unknown signal value', () => {
    const p = writeJson('bad-signal.json', {
      version: 1,
      upload: { bucket: 'b', signals: ['logs', 'profiles'] },
    })
    expect(() => loadConfig(p)).toThrow(/\/upload\/signals\/1/)
  })

  it('rejects negative catchupDays', () => {
    const p = writeJson('neg-catchup.json', {
      version: 1,
      upload: { bucket: 'b', catchupDays: -1 },
    })
    expect(() => loadConfig(p)).toThrow(/\/upload\/catchupDays.*non-negative/)
  })

  it('rejects non-integer catchupDays', () => {
    const p = writeJson('frac-catchup.json', {
      version: 1,
      upload: { bucket: 'b', catchupDays: 1.5 },
    })
    expect(() => loadConfig(p)).toThrow(/\/upload\/catchupDays/)
  })

  it('rejects unknown keys inside upload', () => {
    const p = writeJson('upload-typo.json', {
      version: 1,
      upload: { bucket: 'b', mistery: true },
    })
    expect(() => loadConfig(p)).toThrow(/\/upload\/mistery/)
  })
})

describe('loadConfig - valid configs', () => {
  it('loads a version-only config (every section is optional)', () => {
    const cfg = { version: 1 }
    const p = writeJson('v1-only.json', cfg)
    expect(loadConfig(p)).toEqual(cfg)
  })

  it('loads an otel-only config (with required sink)', () => {
    const cfg = { version: 1, otel: { listen: '0.0.0.0:4318' }, sink: { type: 'file', dir: '/tmp' } }
    const p = writeJson('otel.json', cfg)
    expect(loadConfig(p)).toEqual(cfg)
  })

  it('loads a proxy-only config (with required sink)', () => {
    const cfg = {
      version: 1,
      proxy: {
        listen: '0.0.0.0:8080',
        upstreams: [
          {
            name: 'anthropic',
            base_url: 'https://api.anthropic.com',
            match: { path_prefix: '/v1/messages' },
          },
        ],
      },
      sink: { type: 'file', dir: '/var/log/collectivus' },
    }
    const p = writeJson('proxy.json', cfg)
    expect(loadConfig(p)).toEqual(cfg)
  })

  it('loads a config with both otel and proxy', () => {
    const cfg = {
      version: 1,
      otel: { listen: '0.0.0.0:4318' },
      proxy: {
        listen: '0.0.0.0:8080',
        redact_headers: ['authorization', 'x-api-key'],
        upstreams: [
          {
            name: 'anthropic',
            base_url: 'https://api.anthropic.com',
            match: { path_prefix: '/v1/messages' },
          },
          {
            name: 'openai',
            base_url: 'https://api.openai.com',
            match: { path_prefix: '/v1/chat' },
          },
        ],
      },
      sink: { type: 'file', dir: '/var/log/collectivus' },
    }
    const p = writeJson('both.json', cfg)
    expect(loadConfig(p)).toEqual(cfg)
  })
})
