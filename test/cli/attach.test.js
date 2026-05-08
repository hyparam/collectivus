import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ConfigError } from '../../src/config.js'
import { parseAttachArgs, runAttach } from '../../src/cli/attach.js'

/**
 * @returns {{ write: (s: string) => void, value: () => string }}
 */
function memo() {
  let buf = ''
  return {
    write(s) { buf += s },
    value() { return buf },
  }
}

/** @type {string} */
let tmpDir
beforeEach(function() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-attach-'))
})
afterEach(function() {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('parseAttachArgs', function() {
  it('requires one of --config or --port', function() {
    expect(parseAttachArgs([]).error).toMatch(/one of --config or --port/)
  })

  it('rejects both --config and --port', function() {
    expect(parseAttachArgs(['--config', 'c', '--port', '8787']).error).toMatch(/mutually exclusive/)
  })

  it('parses --config <path>', function() {
    expect(parseAttachArgs(['--config', '/tmp/c.json'])).toMatchObject({
      configPath: '/tmp/c.json', port: null, help: false, error: null,
    })
  })

  it('parses --port <n>', function() {
    expect(parseAttachArgs(['--port', '8787'])).toMatchObject({
      configPath: null, port: 8787, error: null,
    })
  })

  it('rejects out-of-range --port', function() {
    expect(parseAttachArgs(['--port=70000']).error).toMatch(/not a valid port/)
    expect(parseAttachArgs(['--port=0']).error).toMatch(/not a valid port/)
  })

  it('rejects non-numeric --port', function() {
    expect(parseAttachArgs(['--port=abc']).error).toMatch(/not a valid port/)
  })

  it('returns help mode for --help', function() {
    expect(parseAttachArgs(['--help']).help).toBe(true)
    expect(parseAttachArgs(['-h']).help).toBe(true)
  })

  it('rejects unknown args', function() {
    expect(parseAttachArgs(['--mystery']).error).toMatch(/unknown argument/)
  })
})

describe('runAttach', function() {
  it('prints help on --help', async function() {
    const stdout = memo()
    const code = await runAttach(['--help'], { stdout, stderr: memo() })
    expect(code).toBe(0)
    expect(stdout.value()).toMatch(/Usage:/)
  })

  it('exits 2 on missing args', async function() {
    const stderr = memo()
    const code = await runAttach([], { stdout: memo(), stderr })
    expect(code).toBe(2)
    expect(stderr.value()).toMatch(/one of --config or --port/)
  })

  it('--port: attaches with given port', async function() {
    const stdout = memo()
    const stderr = memo()
    /** @type {object[]} */
    const calls = []
    const code = await runAttach(['--port', '9090'], {
      stdout, stderr,
      version: '2.0.0',
      settingsPath: path.join(tmpDir, 'settings.json'),
      attach(o) { calls.push(o); return Promise.resolve({ changed: true }) },
    })
    expect(code).toBe(0)
    expect(calls).toEqual([{
      port: 9090, version: '2.0.0', settingsPath: path.join(tmpDir, 'settings.json'),
    }])
    expect(stdout.value()).toMatch(/Claude Code attached/)
    expect(stdout.value()).toMatch(/ANTHROPIC_BASE_URL = http:\/\/127\.0\.0\.1:9090/)
  })

  it('--config: derives port from proxy.listen', async function() {
    const stdout = memo()
    const stderr = memo()
    const cfg = { proxy: { listen: '0.0.0.0:8765', upstreams: {} } }
    /** @type {Array<import('../../src/claude-code/settings.js').AttachOptions>} */
    const calls = []
    const code = await runAttach(['--config', '/tmp/x'], {
      stdout, stderr,
      version: '2.0.0',
      settingsPath: path.join(tmpDir, 'settings.json'),
      loadConfig() { return cfg },
      attach(o) { calls.push(o); return Promise.resolve({ changed: true }) },
    })
    expect(code).toBe(0)
    expect(calls[0].port).toBe(8765)
  })

  it('--config: surfaces ConfigError as code 1', async function() {
    const stderr = memo()
    const code = await runAttach(['--config', '/tmp/x'], {
      stdout: memo(), stderr,
      loadConfig() { throw new ConfigError('config file not found: /tmp/x') },
      attach() { return Promise.resolve({ changed: true }) },
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/config error.*not found/)
  })

  it('--config: errors when proxy is missing', async function() {
    const stderr = memo()
    const code = await runAttach(['--config', '/tmp/x'], {
      stdout: memo(), stderr,
      loadConfig() { return { otel: { listen: '0.0.0.0:4318' } } },
      attach() { return Promise.resolve({ changed: true }) },
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/proxy.listen/)
  })

  it('reports prevValue when attach overwrote ANTHROPIC_BASE_URL', async function() {
    const stdout = memo()
    const code = await runAttach(['--port', '8787'], {
      stdout, stderr: memo(),
      version: '1.0.0',
      settingsPath: path.join(tmpDir, 'settings.json'),
      attach() { return Promise.resolve({ changed: true, prevValue: 'https://old.test' }) },
    })
    expect(code).toBe(0)
    expect(stdout.value()).toMatch(/previous ANTHROPIC_BASE_URL was https:\/\/old\.test/)
  })

  it('exits 1 when attach throws', async function() {
    const stderr = memo()
    const code = await runAttach(['--port', '8787'], {
      stdout: memo(), stderr,
      attach() { return Promise.reject(new Error('settings malformed')) },
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/failed to attach Claude Code.*settings malformed/)
  })
})
