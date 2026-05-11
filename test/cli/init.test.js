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
      expect(written.query).toEqual({ parquet: { enabled: true } })
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
        '1', '', cfgPath, 'y', 'n',
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

    it('defaults the save path to ~/.hyp/collectivus.json and creates the parent dir', async function() {
      const stdout = memo()
      const stderr = memo()
      const fakeHome = path.join(tmpDir, 'home')
      const expectedCfg = path.join(fakeHome, '.hyp', 'collectivus.json')
      const { prompt, asked } = scriptedPrompt([
        '1', // standalone
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
        '1', '', cfgPath, 'y', // single / default sink / save / confirm
        'y', // install daemon
        'y', // attach Claude Code
      ])
      /** @type {string[][]} */
      const installCalls = []
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'darwin',
        cwd: tmpDir,
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
        '1', '', cfgPath, 'y',
        'y', // install daemon
        'n', // skip Claude Code
      ])
      /** @type {string[][]} */
      const installCalls = []
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'darwin',
        cwd: tmpDir,
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
        '1', '', cfgPath, 'y',
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
        '1', '', cfgPath, 'n',
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

    it('skips daemon install offer when running via npx and prints global-install hint', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'cfg.json')
      const { prompt, asked } = scriptedPrompt([
        '1', '', cfgPath, 'y',
      ])
      /** @type {string[][]} */
      const installCalls = []
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'darwin',
        cwd: tmpDir,
        defaultConfigPath: absentDefaultCfg,
        binPath: '/Users/test/.npm/_npx/abc123/node_modules/.bin/collectivus',
        runInstall(args) { installCalls.push(args); return Promise.resolve(0) },
      })
      expect(code).toBe(0)
      expect(installCalls).toHaveLength(0)
      expect(asked.some(function(q) { return /background daemon/.test(q) })).toBe(false)
      expect(stdout.value()).toMatch(/npx -p collectivus ctvs --config/)
      expect(stdout.value()).toMatch(/npm install -g collectivus/)
    })
  })

  describe('mode prompt', function() {
    it('re-prompts on invalid mode answer until a valid one is given', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'cfg.json')
      const { prompt, asked } = scriptedPrompt([
        'oops', '7', '', // two bad answers, then accept default (1 = standalone)
        '', cfgPath, 'y', 'n',
      ])
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'darwin',
        cwd: tmpDir,
        defaultConfigPath: absentDefaultCfg,
      })
      expect(code).toBe(0)
      expect(stderr.value()).toMatch(/please choose 1, 2, or 3 \(got "oops"\)/)
      expect(stderr.value()).toMatch(/please choose 1, 2, or 3 \(got "7"\)/)
      expect(asked.filter(function(q) { return q === 'Choose [1]: ' })).toHaveLength(3)
      expect(fs.existsSync(cfgPath)).toBe(true)
    })
  })

  describe('gateway-mode walkthrough', function() {
    it('writes a valid role:gateway config with central_server + poll_interval_seconds', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'gw.json')
      const sinkDir = path.join(tmpDir, 'gw-sink')
      const { prompt, asked } = scriptedPrompt([
        '2', // gateway
        'https://central.example.com:8788', // central server URL
        '60', // poll_interval_seconds override
        '1', // capture mode: proxy only
        '1', // anthropic
        '', // default proxy listen
        sinkDir,
        '', // keep local query cache
        cfgPath, // save path
        'y', // confirm write
        'n', // decline daemon install
      ])
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'darwin',
        cwd: tmpDir,
        defaultConfigPath: absentDefaultCfg,
        defaultSinkDir: sinkDir,
      })
      expect(code).toBe(0)
      const written = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      expect(written.version).toBe(1)
      expect(written.role).toBe('gateway')
      expect(written.central_server.url).toBe('https://central.example.com:8788')
      expect(written.central_server.poll_interval_seconds).toBe(60)
      expect(written.central_server.identity).toEqual({})
      expect(written.proxy.listen).toBe('127.0.0.1:8787')
      expect(written.proxy.upstreams[0].name).toBe('anthropic')
      expect(written.sink.dir).toBe(sinkDir)
      expect(written.query).toEqual({ parquet: { enabled: true } })
      expect(written.otel).toBeUndefined()
      const loaded = loadConfig(cfgPath)
      expect(loaded.role).toBe('gateway')
      expect(stdout.value()).toMatch(/ctvs config set <gateway-id>/)
      expect(stdout.value()).toMatch(/before this gateway will see anything to load/)
      expect(stdout.value()).toMatch(/bootstrap_token in/)
      expect(asked.some(function(q) { return /bootstrap.token/i.test(q) })).toBe(false)
    })

    it('omits poll_interval_seconds when the user accepts the default', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'gw.json')
      const { prompt } = scriptedPrompt([
        '2', // gateway
        'https://central.example.com:8788',
        '', // accept default poll interval (omitted from config)
        '2', // capture: otel only
        '127.0.0.1:4319', // otel listen override
        path.join(tmpDir, 'gw-sink'),
        '',
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
      expect(written.central_server.poll_interval_seconds).toBeUndefined()
      expect(written.proxy).toBeUndefined()
      expect(written.otel.listen).toBe('127.0.0.1:4319')
    })

    it('re-prompts on out-of-range poll_interval_seconds', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'gw.json')
      const { prompt, asked } = scriptedPrompt([
        '2',
        'https://central.example.com:8788',
        '0', // below 5
        '4000', // above 3600
        'banana', // not a number
        '15', // valid
        '1', // capture: proxy only
        '1', '', // anthropic, default listen
        path.join(tmpDir, 'gw-sink'),
        '',
        cfgPath,
        'y', 'n',
      ])
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'darwin',
        cwd: tmpDir,
        defaultConfigPath: absentDefaultCfg,
      })
      expect(code).toBe(0)
      const written = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
      expect(written.central_server.poll_interval_seconds).toBe(15)
      expect(stderr.value()).toMatch(/must be an integer between 5 and 3600/)
      expect(asked.filter(function(q) { return q.startsWith('Poll interval') })).toHaveLength(4)
    })

    it('re-prompts on invalid central server URL', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'gw.json')
      const { prompt, asked } = scriptedPrompt([
        '2',
        '', // empty rejected
        'not a url', // unparseable rejected
        'https://central.example.com:8788',
        '', // default poll interval
        '1', // capture proxy
        '1', '', // anthropic, default listen
        path.join(tmpDir, 'gw-sink'),
        '',
        cfgPath, 'y', 'n',
      ])
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'darwin',
        cwd: tmpDir,
        defaultConfigPath: absentDefaultCfg,
      })
      expect(code).toBe(0)
      expect(stderr.value()).toMatch(/url is required/)
      expect(stderr.value()).toMatch(/url must be a valid URL/)
      expect(asked.filter(function(q) { return q === 'Central server URL: ' })).toHaveLength(3)
    })
  })

  describe('central-server walkthrough', function() {
    it('writes a valid role:server config with the operator-supplied data_dir', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'server.json')
      const dataDir = path.join(tmpDir, 'server-data')
      const { prompt } = scriptedPrompt([
        '3', // central server
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
      expect(written.query).toEqual({ parquet: { enabled: true } })
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
        '3',
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
        '3',
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

    it('skips daemon install offer when reusing an existing config via npx', async function() {
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
      ])
      /** @type {string[][]} */
      const installCalls = []
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'darwin',
        cwd: tmpDir,
        defaultConfigPath: cfgPath,
        binPath: '/Users/test/.npm/_npx/abc123/node_modules/.bin/collectivus',
        readConfig() { return existing },
        runInstall(args) { installCalls.push(args); return Promise.resolve(0) },
      })
      expect(code).toBe(0)
      expect(installCalls).toHaveLength(0)
      expect(asked.some(function(q) { return /background daemon/.test(q) })).toBe(false)
      expect(stdout.value()).toMatch(/npm install -g collectivus/)
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

    it('reusing an otel-only config skips the daemon prompt', async function() {
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
      ])
      const code = await runInit({
        stdout, stderr, prompt,
        platform: 'darwin',
        cwd: tmpDir,
        defaultConfigPath: cfgPath,
        readConfig() { return existing },
      })
      expect(code).toBe(0)
      expect(asked.some(function(q) { return /background daemon/.test(q) })).toBe(false)
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
