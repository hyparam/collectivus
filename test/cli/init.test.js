import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runInit } from '../../src/cli/init.js'
import { loadConfig } from '../../src/config.js'

/**
 * @import { CollectivusConfig } from '../../src/types.js'
 */

/**
 * Minimal in-memory stream collector.
 *
 * @returns {{ write: (s: string) => void, value: () => string }}
 */
function memo() {
  let buf = ''
  return {
    write(s) { buf += s },
    value() { return buf },
  }
}

/**
 * Build a prompt mock that returns successive answers from `answers` and
 * records every question it was asked.
 *
 * @param {string[]} answers
 * @returns {{ prompt: (q: string) => Promise<string>, asked: string[] }}
 */
function scriptedPrompt(answers) {
  /** @type {string[]} */
  const asked = []
  const queue = answers.slice()
  return {
    asked,
    prompt(q) {
      asked.push(q)
      if (queue.length === 0) {
        return Promise.reject(new Error(`prompt exhausted at: ${q}`))
      }
      return Promise.resolve(queue.shift() ?? '')
    },
  }
}

/** @type {string} */
let tmpDir
/**
 * Path inside `tmpDir` that no test creates. Tests pass this as
 * `defaultConfigPath` so the "found existing config" branch sees nothing
 * and falls through to the question flow.
 *
 * @type {string}
 */
let absentDefaultCfg
beforeEach(function() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-init-'))
  absentDefaultCfg = path.join(tmpDir, 'absent-default.json')
})
afterEach(function() {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('runInit', function() {
  describe('standalone mode', function() {
    it('writes a v1 config with localhost proxy + Anthropic upstream array', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'collectivus.json')
      const sinkDir = path.join(tmpDir, 'sink')
      const { prompt, asked } = scriptedPrompt([
        '1', // standalone
        '', // default source selection (proxy)
        '', // accept default sink (resolves to override below)
        cfgPath, // save path
        'y', // confirm write
        'n', // skip daemon
      ])
      /** @type {string[]} */
      const installCalls = []
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'darwin',
        cwd: tmpDir,
        defaultSinkDir: sinkDir,
        defaultConfigPath: absentDefaultCfg,
        runInstall(args) { installCalls.push(args.join(' ')); return Promise.resolve(0) },
      })
      expect(code).toBe(0)
      expect(installCalls).toHaveLength(0)
      expect(fs.existsSync(cfgPath)).toBe(true)
      const written = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      expect(written.version).toBe(1)
      expect(written.proxy).toMatchObject({
        listen: '127.0.0.1:8787',
        upstreams: [
          {
            name: 'anthropic',
            base_url: 'https://api.anthropic.com',
            match: { path_prefix: '/v1/messages' },
          },
        ],
      })
      expect(written.proxy.redact_headers).toContain('x-api-key')
      expect(written.sink).toEqual({ type: 'file', dir: sinkDir })
      expect(written.query).toEqual({ cache: { enabled: true } })
      expect(written.otel).toBeUndefined()
      expect(written.upload).toBeUndefined()
      expect(stdout.value()).toMatch(/Wrote/)
      // Standalone does not ask about provider, OTLP, upload, or proxy listen.
      expect(asked.some(function(q) { return /Provider \[1\]/.test(q) })).toBe(false)
      expect(asked.some(function(q) { return /OTLP/i.test(q) })).toBe(false)
      expect(asked.some(function(q) { return /Upload daily/i.test(q) })).toBe(false)
      expect(asked.some(function(q) { return /Proxy listen/i.test(q) })).toBe(false)
    })

    it('produced config round-trips through loadConfig', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'collectivus.json')
      const sinkDir = path.join(tmpDir, 'sink')
      const { prompt } = scriptedPrompt([
        '1', '', '', cfgPath, 'y', 'n',
      ])
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'darwin',
        cwd: tmpDir,
        defaultSinkDir: sinkDir,
        defaultConfigPath: absentDefaultCfg,
      })
      expect(code).toBe(0)
      // The validator should accept the file the walkthrough wrote.
      expect(function() { loadConfig(cfgPath) }).not.toThrow()
    })

    it('supports selecting all capture sources and auto-adds discovered gas cities', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'collectivus.json')
      const sinkDir = path.join(tmpDir, 'sink')
      const citiesRoot = path.join(tmpDir, 'cities')
      const cityDir = path.join(citiesRoot, 'mycity')
      fs.mkdirSync(cityDir, { recursive: true })
      fs.writeFileSync(
        path.join(cityDir, 'city.toml'),
        'name = "mycity"\napi = "http://127.0.0.1:8372"\n',
        'utf8'
      )
      const { prompt, asked } = scriptedPrompt([
        '1', // standalone
        'all', // proxy + gascity + otel
        '', // default sink
        citiesRoot, // scan for gas cities
        '', // add discovered city
        '', // add no more cities
        '', // default OTLP listen
        cfgPath,
        'y',
        'n', // skip daemon
      ])
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'darwin',
        cwd: tmpDir,
        defaultSinkDir: sinkDir,
        defaultConfigPath: absentDefaultCfg,
      })
      expect(code).toBe(0)
      const written = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      expect(written.proxy.listen).toBe('127.0.0.1:8787')
      expect(written.gascity).toEqual([{ name: 'mycity', api_url: 'http://127.0.0.1:8372' }])
      expect(written.otel).toEqual({ listen: '127.0.0.1:4318' })
      expect(asked).toContain('Enable sources [1]: ')
      expect(stdout.value()).toMatch(/Discovered gas city supervisors/)
    })

    it('supports a gascity-only source without asking to attach Claude Code', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'gascity.json')
      const cityDir = path.join(tmpDir, 'mycity')
      fs.mkdirSync(cityDir, { recursive: true })
      fs.writeFileSync(
        path.join(cityDir, 'city.toml'),
        'name = "mycity"\napi = "http://127.0.0.1:8372"\n',
        'utf8'
      )
      const { prompt, asked } = scriptedPrompt([
        '1', // standalone
        '2', // gascity only
        '', // default sink
        cityDir,
        '', // add discovered city
        '', // add no more cities
        cfgPath,
        'y',
        'y', // install daemon
      ])
      /** @type {string[][]} */
      const installCalls = []
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'darwin',
        cwd: tmpDir,
        binPath: '/usr/local/bin/ctvs',
        defaultConfigPath: absentDefaultCfg,
        runInstall(args) { installCalls.push(args); return Promise.resolve(0) },
      })
      expect(code).toBe(0)
      const written = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      expect(written.proxy).toBeUndefined()
      expect(written.otel).toBeUndefined()
      expect(written.gascity).toEqual([{ name: 'mycity', api_url: 'http://127.0.0.1:8372' }])
      expect(installCalls).toEqual([['--config', cfgPath, '--no']])
      expect(asked.some(function(q) { return /Configure Claude Code/.test(q) })).toBe(false)
    })

    it('defaults the save path to ~/.hyp/collectivus.json and creates the parent dir', async function() {
      const stdout = memo()
      const stderr = memo()
      const fakeHome = path.join(tmpDir, 'home')
      const expectedCfg = path.join(fakeHome, '.hyp', 'collectivus.json')
      const { prompt, asked } = scriptedPrompt([
        '1', // standalone
        '', // default source selection (proxy)
        '', // default sink
        '', // accept default save path
        'y', // confirm write
        'n', // skip daemon
      ])
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'darwin',
        cwd: tmpDir,
        defaultConfigPath: expectedCfg,
      })
      expect(code).toBe(0)
      expect(asked.some(function(q) { return q.includes(expectedCfg) })).toBe(true)
      expect(fs.existsSync(expectedCfg)).toBe(true)
      expect(fs.existsSync(path.dirname(expectedCfg))).toBe(true)
    })

    it('chains into runInstall with --yes when daemon + Claude Code accepted', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'collectivus.json')
      const { prompt } = scriptedPrompt([
        '1', '', '', cfgPath, 'y', // single / default sources / sink / save / confirm
        'y', // install daemon
        'y', // attach Claude Code
      ])
      /** @type {string[][]} */
      const installCalls = []
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'darwin',
        cwd: tmpDir,
        binPath: '/usr/local/bin/ctvs',
        defaultConfigPath: absentDefaultCfg,
        runInstall(args) { installCalls.push(args); return Promise.resolve(0) },
      })
      expect(code).toBe(0)
      expect(installCalls).toEqual([['--config', cfgPath, '--yes']])
    })

    it('chains into runInstall with --no when daemon accepted but Claude Code declined', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'cfg.json')
      const { prompt } = scriptedPrompt([
        '1', '', '', cfgPath, 'y',
        'y', // install daemon
        'n', // skip Claude Code
      ])
      /** @type {string[][]} */
      const installCalls = []
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'darwin',
        cwd: tmpDir,
        binPath: '/usr/local/bin/ctvs',
        defaultConfigPath: absentDefaultCfg,
        runInstall(args) { installCalls.push(args); return Promise.resolve(0) },
      })
      expect(code).toBe(0)
      expect(installCalls).toEqual([['--config', cfgPath, '--no']])
    })

    it('does not offer daemon install on unsupported platforms', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'cfg.json')
      const { prompt, asked } = scriptedPrompt([
        '1', '', '', cfgPath, 'y',
      ])
      /** @type {string[][]} */
      const installCalls = []
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'win32',
        cwd: tmpDir,
        defaultConfigPath: absentDefaultCfg,
        runInstall(args) { installCalls.push(args); return Promise.resolve(0) },
      })
      expect(code).toBe(0)
      expect(installCalls).toHaveLength(0)
      expect(asked.some(function(q) { return /background daemon/.test(q) })).toBe(false)
    })

    it('aborts cleanly when the write confirmation is declined', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'cfg.json')
      const { prompt } = scriptedPrompt([
        '1', '', '', cfgPath, 'n',
      ])
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'darwin',
        cwd: tmpDir,
        defaultConfigPath: absentDefaultCfg,
      })
      expect(code).toBe(0)
      expect(fs.existsSync(cfgPath)).toBe(false)
      expect(stdout.value()).toMatch(/Aborted/)
    })

    it('bootstraps global install when running via npx and daemon install is selected', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'cfg.json')
      const { prompt, asked } = scriptedPrompt([
        '1', '', '', cfgPath, 'y', 'y', 'y',
      ])
      /** @type {Array<{ args: string[], binPath: string | undefined }>} */
      const installCalls = []
      let globalInstallCalls = 0
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'darwin',
        cwd: tmpDir,
        defaultConfigPath: absentDefaultCfg,
        binPath: '/Users/test/.npm/_npx/abc123/node_modules/.bin/collectivus',
        installGlobal() { globalInstallCalls++; return Promise.resolve(true) },
        resolveGlobalBinPath() { return Promise.resolve('/usr/local/lib/node_modules/collectivus/bin/cli.js') },
        runInstall(args, hooks) {
          installCalls.push({ args, binPath: hooks?.binPath })
          return Promise.resolve(0)
        },
      })
      expect(code).toBe(0)
      expect(globalInstallCalls).toBe(1)
      expect(installCalls).toEqual([{
        args: ['--config', cfgPath, '--yes'],
        binPath: '/usr/local/lib/node_modules/collectivus/bin/cli.js',
      }])
      expect(asked.some(function(q) { return /background daemon/.test(q) })).toBe(true)
      expect(stdout.value()).toMatch(/Installing collectivus globally with npm/)
    })
  })

  describe('mode prompt', function() {
    it('re-prompts on invalid mode answer until a valid one is given', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'cfg.json')
      const { prompt, asked } = scriptedPrompt([
        'oops', '7', '', // two bad answers, then accept default (1 = standalone)
        '', '', cfgPath, 'y', 'n',
      ])
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'darwin',
        cwd: tmpDir,
        defaultConfigPath: absentDefaultCfg,
      })
      expect(code).toBe(0)
      expect(stderr.value()).toMatch(/please choose 1 or 2 \(got "oops"\)/)
      expect(stderr.value()).toMatch(/please choose 1 or 2 \(got "7"\)/)
      expect(asked.filter(function(q) { return q === 'Choose [1]: ' })).toHaveLength(3)
      expect(fs.existsSync(cfgPath)).toBe(true)
      expect(stdout.value()).toMatch(/2\) Central server/)
      expect(stdout.value()).not.toMatch(/2\) Gateway/)
    })
  })

  describe('central-server walkthrough', function() {
    it('writes a valid role:server config with the operator-supplied data_dir', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'server.json')
      const dataDir = path.join(tmpDir, 'server-data')
      const { prompt } = scriptedPrompt([
        '2', // central server
        '', // accept default central-server listen
        'https://collectivus.example.com:8788', // gateway-facing URL
        dataDir, // server data directory
        '', // generate identity-issuer secret
        '', // no S3 upload
        cfgPath, // save path
        'y', // confirm write
      ])
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'darwin',
        cwd: tmpDir,
        defaultConfigPath: absentDefaultCfg,
      })
      expect(code).toBe(0)
      const written = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      expect(written.version).toBe(1)
      expect(written.role).toBe('server')
      expect(written.server.control_plane_listen).toBe('0.0.0.0:8788')
      expect(written.server.public_url).toBe('https://collectivus.example.com:8788')
      expect(written.server.data_dir).toBe(dataDir)
      expect(written.server.sink_dir).toBe(path.join(dataDir, 'ingested'))
      expect(written.server.identity_issuer.bootstrap_store_path).toBe(path.join(dataDir, 'bootstrap.json'))
      expect(typeof written.server.identity_issuer.secret).toBe('string')
      expect(written.server.identity_issuer.secret.length).toBe(64)
      expect(written.server.identity_issuer.secret).toMatch(/^[0-9a-f]+$/)
      expect(written.query).toEqual({ cache: { enabled: true } })
      const loaded = loadConfig(cfgPath)
      expect(loaded.role).toBe('server')
      expect(stdout.value()).toMatch(/ctvs config bootstrap-token issue/)
      expect(stdout.value()).toMatch(/npx collectivus --config-endpoint='https:\/\/collectivus\.example\.com:8788\/v1\/bootstrap-config\?token=<bootstrap-token>'/)
      expect(stdout.value()).toMatch(/ctvs config set <gateway-id>/)
    })

    it('falls back to a generated secret when the operator-supplied value is too short', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'server.json')
      const { prompt } = scriptedPrompt([
        '2',
        '127.0.0.1:9999', // explicit central-server listen
        '', // default gateway-facing URL derived from listen
        '', // default data_dir
        'too-short', // shorter than 32 chars
        '', // no upload
        cfgPath,
        'y',
      ])
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'darwin',
        cwd: tmpDir,
        defaultConfigPath: absentDefaultCfg,
      })
      expect(code).toBe(0)
      expect(stderr.value()).toMatch(/secret shorter than 32 chars/)
      const written = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      expect(written.server.public_url).toBe('http://127.0.0.1:9999')
      expect(written.server.identity_issuer.secret).not.toBe('too-short')
      expect(written.server.identity_issuer.secret.length).toBe(64)
    })

    it('attaches an upload block when the operator opts in', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'server.json')
      const { prompt } = scriptedPrompt([
        '2',
        '', // default listen
        '', // default gateway-facing URL
        path.join(tmpDir, 'server-data'),
        '', // generate secret
        'y', // upload
        'my-server-archive', // bucket
        '', // default region
        '', // default prefix
        '', // default time
        '', // default signals
        '', // no custom endpoint
        cfgPath,
        'y',
      ])
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'darwin',
        cwd: tmpDir,
        defaultConfigPath: absentDefaultCfg,
      })
      expect(code).toBe(0)
      const written = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      expect(written.upload.bucket).toBe('my-server-archive')
    })
  })

  describe('existing config reuse', function() {
    it('reuses an existing config and chains into runInstall', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'existing.json')
      /** @type {CollectivusConfig} */
      const existing = {
        version: 1,
        proxy: {
          listen: '127.0.0.1:8787',
          upstreams: [{ name: 'anthropic', base_url: 'https://api.anthropic.com', match: { path_prefix: '/v1/messages' } }],
          redact_headers: ['authorization'],
        },
        sink: { type: 'file', dir: path.join(tmpDir, 'sink') },
      }
      const { prompt, asked } = scriptedPrompt([
        '', // accept reuse (default = use)
        'y', // install daemon
        'y', // attach Claude Code
      ])
      /** @type {string[][]} */
      const installCalls = []
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'darwin',
        cwd: tmpDir,
        binPath: '/usr/local/bin/ctvs',
        defaultConfigPath: cfgPath,
        readConfig() { return existing },
        runInstall(args) { installCalls.push(args); return Promise.resolve(0) },
      })
      expect(code).toBe(0)
      expect(installCalls).toEqual([['--config', cfgPath, '--yes']])
      expect(stdout.value()).toMatch(/Found an existing config/)
      expect(stdout.value()).toMatch(/127\.0\.0\.1:8787/)
      expect(stdout.value()).toMatch(/anthropic → https:\/\/api\.anthropic\.com\/v1\/messages/)
      // Did not ask the new top-level mode question or provider.
      expect(asked.some(function(q) { return /How will you use collectivus/.test(q) })).toBe(false)
      expect(asked.some(function(q) { return /Provider \[1\]/.test(q) })).toBe(false)
    })

    it('bootstraps global install when reusing an existing config via npx', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'existing.json')
      /** @type {CollectivusConfig} */
      const existing = {
        version: 1,
        proxy: {
          listen: '127.0.0.1:8787',
          upstreams: [{ name: 'anthropic', base_url: 'https://api.anthropic.com', match: { path_prefix: '/v1/messages' } }],
        },
        sink: { type: 'file', dir: path.join(tmpDir, 'sink') },
      }
      const { prompt, asked } = scriptedPrompt([
        '', // accept reuse
        'y', // install daemon
        'y', // attach Claude Code
      ])
      /** @type {Array<{ args: string[], binPath: string | undefined }>} */
      const installCalls = []
      let globalInstallCalls = 0
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'darwin',
        cwd: tmpDir,
        defaultConfigPath: cfgPath,
        binPath: '/Users/test/.npm/_npx/abc123/node_modules/.bin/collectivus',
        readConfig() { return existing },
        installGlobal() { globalInstallCalls++; return Promise.resolve(true) },
        resolveGlobalBinPath() { return Promise.resolve('/usr/local/lib/node_modules/collectivus/bin/cli.js') },
        runInstall(args, hooks) {
          installCalls.push({ args, binPath: hooks?.binPath })
          return Promise.resolve(0)
        },
      })
      expect(code).toBe(0)
      expect(globalInstallCalls).toBe(1)
      expect(installCalls).toEqual([{
        args: ['--config', cfgPath, '--yes'],
        binPath: '/usr/local/lib/node_modules/collectivus/bin/cli.js',
      }])
      expect(asked.some(function(q) { return /background daemon/.test(q) })).toBe(true)
      expect(stdout.value()).toMatch(/Installing collectivus globally with npm/)
    })

    it('declining the existing config falls through to the question flow', async function() {
      const stdout = memo()
      const stderr = memo()
      const existingPath = path.join(tmpDir, 'existing.json')
      const newCfgPath = path.join(tmpDir, 'new.json')
      /** @type {CollectivusConfig} */
      const existing = {
        version: 1,
        proxy: {
          listen: '127.0.0.1:9999',
          upstreams: [{ name: 'anthropic', base_url: 'https://api.anthropic.com', match: { path_prefix: '/v1/messages' } }],
        },
        sink: { type: 'file', dir: path.join(tmpDir, 'old-sink') },
      }
      const { prompt } = scriptedPrompt([
        '2', // reject reuse
        '1', // standalone
        '', // default source selection (proxy)
        '', // default sink
        newCfgPath, // save to a new path
        'y', // confirm write
        'n', // skip daemon
      ])
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'darwin',
        cwd: tmpDir,
        defaultConfigPath: existingPath,
        readConfig() { return existing },
      })
      expect(code).toBe(0)
      expect(fs.existsSync(newCfgPath)).toBe(true)
      const written = JSON.parse(fs.readFileSync(newCfgPath, 'utf8'))
      expect(written.proxy.listen).toBe('127.0.0.1:8787')
    })

    it('reusing an otel-only config offers the daemon prompt without Claude Code attach', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'existing.json')
      /** @type {CollectivusConfig} */
      const existing = {
        version: 1,
        otel: { listen: '0.0.0.0:4318' },
        sink: { type: 'file', dir: path.join(tmpDir, 'sink') },
      }
      const { prompt, asked } = scriptedPrompt([
        '1', // reuse explicitly
        'n', // skip daemon
      ])
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'darwin',
        cwd: tmpDir,
        defaultConfigPath: cfgPath,
        readConfig() { return existing },
      })
      expect(code).toBe(0)
      expect(asked.some(function(q) { return /background daemon/.test(q) })).toBe(true)
      expect(asked.some(function(q) { return /Configure Claude Code/.test(q) })).toBe(false)
      expect(stdout.value()).toMatch(/Next steps:/)
    })

    it('summary surfaces the upload block when present', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'existing.json')
      /** @type {CollectivusConfig} */
      const existing = {
        version: 1,
        proxy: {
          listen: '127.0.0.1:8787',
          upstreams: [{ name: 'anthropic', base_url: 'https://api.anthropic.com', match: { path_prefix: '/v1/messages' } }],
        },
        sink: { type: 'file', dir: path.join(tmpDir, 'sink') },
        upload: {
          bucket: 'team-archive',
          region: 'us-east-1',
          prefix: 'collectivus',
          time: '00:10',
          signals: ['logs', 'traces', 'metrics'],
        },
      }
      const { prompt } = scriptedPrompt([
        '1', // reuse
        'n', // skip daemon
      ])
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'darwin',
        cwd: tmpDir,
        defaultConfigPath: cfgPath,
        readConfig() { return existing },
      })
      expect(code).toBe(0)
      expect(stdout.value()).toMatch(/upload: s3:\/\/team-archive\/collectivus daily at 00:10 UTC/)
    })
  })
})
