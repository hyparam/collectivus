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
 * Minimal in-memory stream collector, matching the existing CLI test helper.
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
 * `defaultConfigPath` so the new "found existing config" branch sees nothing
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
  it('proxy-only flow with Anthropic preset writes a valid config', async function() {
    const stdout = memo()
    const stderr = memo()
    const cfgPath = path.join(tmpDir, 'collectivus.json')
    const sinkDir = path.join(tmpDir, 'sink')
    const { prompt } = scriptedPrompt([
      '1', // proxy only
      '1', // Anthropic
      '', // default proxy listen
      '', // default sink dir (resolves to the test override below)
      '', // no S3 upload (default N)
      cfgPath, // save to tmp
      'y', // confirm write
      'n', // skip daemon install
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
    expect(written.upload).toBeUndefined()
    expect(written.otel).toBeUndefined()
    expect(stdout.value()).toMatch(/Wrote/)
  })

  it('defaults the save path to ~/.hyp/collectivus.json and creates the parent dir', async function() {
    const stdout = memo()
    const stderr = memo()
    const fakeHome = path.join(tmpDir, 'home')
    const expectedCfg = path.join(fakeHome, '.hyp', 'collectivus.json')
    const { prompt, asked } = scriptedPrompt([
      '1', '1', '', '', // proxy / anthropic / default listen / default sink
      '', // no S3 upload
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
    // Prompt advertises the ~/.hyp/collectivus.json default explicitly.
    expect(asked.some(function(q) { return q.includes(expectedCfg) })).toBe(true)
    expect(fs.existsSync(expectedCfg)).toBe(true)
    expect(fs.existsSync(path.dirname(expectedCfg))).toBe(true)
  })

  it('otel-only flow skips the daemon prompt and produces an otel+sink config', async function() {
    const stdout = memo()
    const stderr = memo()
    const cfgPath = path.join(tmpDir, 'cfg.json')
    const { prompt } = scriptedPrompt([
      '2', // otel only
      '127.0.0.1:4318', // otel listen override
      path.join(tmpDir, 'data'), // sink dir
      '', // no S3 upload
      cfgPath,
      '', // confirm write (default Y)
    ])
    /** @type {string[]} */
    const installCalls = []
    const code = await runInit({
      stdout, stderr, prompt,
      platform: 'darwin',
      cwd: tmpDir,
      defaultConfigPath: absentDefaultCfg,
      runInstall(args) { installCalls.push(args.join(' ')); return Promise.resolve(0) },
    })
    expect(code).toBe(0)
    expect(installCalls).toHaveLength(0)
    const written = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    expect(written.version).toBe(1)
    expect(written.otel).toEqual({ listen: '127.0.0.1:4318' })
    expect(written.proxy).toBeUndefined()
    expect(written.sink.dir).toBe(path.join(tmpDir, 'data'))
    // No daemon prompt is offered for otel-only because `install` requires
    // a proxy listener.
    expect(stdout.value()).not.toMatch(/Install collectivus as a background daemon/)
    expect(stdout.value()).toMatch(/Next steps:/)
  })

  it('"both" flow asks proxy + otel questions and writes both blocks', async function() {
    const stdout = memo()
    const stderr = memo()
    const cfgPath = path.join(tmpDir, 'cfg.json')
    const { prompt } = scriptedPrompt([
      '3', // both
      '2', // OpenAI
      '127.0.0.1:9090', // proxy listen
      '0.0.0.0:4317', // otel listen
      '', // default sink
      '', // no S3 upload
      cfgPath,
      'y',
      'n', // skip daemon
    ])
    const code = await runInit({
      stdout, stderr, prompt,
      platform: 'linux',
      cwd: tmpDir,
      defaultConfigPath: absentDefaultCfg,
    })
    expect(code).toBe(0)
    const written = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    expect(written.version).toBe(1)
    expect(written.proxy.listen).toBe('127.0.0.1:9090')
    const openai = written.proxy.upstreams.find((/** @type {{ name: string }} */ u) => u.name === 'openai')
    expect(openai.base_url).toBe('https://api.openai.com')
    expect(written.otel).toEqual({ listen: '0.0.0.0:4317' })
  })

  it('custom upstream defaults the name to the derived host slug', async function() {
    const stdout = memo()
    const stderr = memo()
    const cfgPath = path.join(tmpDir, 'cfg.json')
    const { prompt, asked } = scriptedPrompt([
      '1',
      '4', // custom
      'https://api.example.com', // base URL
      '/v2/chat', // prefix
      '', // accept the derived default name
      '', // default proxy listen
      '', // default sink
      '', // no S3 upload
      cfgPath,
      'y',
      'n', // skip daemon
    ])
    const code = await runInit({
      stdout, stderr, prompt,
      platform: 'darwin',
      cwd: tmpDir,
      defaultConfigPath: absentDefaultCfg,
    })
    expect(code).toBe(0)
    expect(asked.some(function(q) { return /Upstream name \[example\]/.test(q) })).toBe(true)
    const written = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    expect(written.version).toBe(1)
    expect(written.proxy.upstreams).toEqual([{
      name: 'example',
      base_url: 'https://api.example.com',
      match: { path_prefix: '/v2/chat' },
    }])
  })

  it('custom upstream accepts an explicit slug name', async function() {
    const stdout = memo()
    const stderr = memo()
    const cfgPath = path.join(tmpDir, 'cfg.json')
    const { prompt } = scriptedPrompt([
      '1',
      '4', // custom
      'https://api.example.com',
      '/v2/chat',
      'my-llm-1', // explicit slug
      '',
      '',
      '', // no S3 upload
      cfgPath,
      'y',
      'n',
    ])
    const code = await runInit({
      stdout, stderr, prompt,
      platform: 'darwin',
      cwd: tmpDir,
      defaultConfigPath: absentDefaultCfg,
    })
    expect(code).toBe(0)
    const written = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    expect(written.proxy.upstreams[0].name).toBe('my-llm-1')
  })

  it('custom upstream re-prompts for slug name when invalid', async function() {
    const stdout = memo()
    const stderr = memo()
    const cfgPath = path.join(tmpDir, 'cfg.json')
    const { prompt, asked } = scriptedPrompt([
      '1', // proxy only
      '4', // custom provider
      'https://api.example.com',
      '/v2/chat',
      'Bad Name', // invalid: capital + space — re-prompts
      'good-name', // valid slug accepted
      '', // default proxy listen
      '', // default sink
      '', // no S3 upload
      cfgPath,
      'y',
      'n',
    ])
    const code = await runInit({
      stdout, stderr, prompt,
      platform: 'darwin',
      cwd: tmpDir,
      defaultConfigPath: absentDefaultCfg,
    })
    expect(code).toBe(0)
    expect(stderr.value()).toMatch(/name must match \[a-z\]\[a-z0-9-\]\*/)
    // Two "Upstream name" prompts: one rejected, one accepted.
    expect(asked.filter(function(q) { return q.startsWith('Upstream name') })).toHaveLength(2)
    const written = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    expect(written.proxy.upstreams[0].name).toBe('good-name')
  })

  it.each([
    ['anthropic', '1', { name: 'anthropic', base_url: 'https://api.anthropic.com', path_prefix: '/v1/messages' }],
    ['openai', '2', { name: 'openai', base_url: 'https://api.openai.com', path_prefix: '/v1' }],
    ['gemini', '3', { name: 'gemini', base_url: 'https://generativelanguage.googleapis.com', path_prefix: '/v1' }],
  ])('preset %s round-trips through loadConfig', async function(_label, choice, expected) {
    const stdout = memo()
    const stderr = memo()
    const cfgPath = path.join(tmpDir, 'cfg.json')
    const sinkDir = path.join(tmpDir, 'sink')
    const { prompt } = scriptedPrompt([
      '1', // proxy only
      choice, // preset choice
      '', // default proxy listen
      '', // default sink (resolves via defaultSinkDir override)
      '', // no S3 upload
      cfgPath,
      'y',
      'n',
    ])
    const code = await runInit({
      stdout, stderr, prompt,
      platform: 'darwin',
      cwd: tmpDir,
      defaultSinkDir: sinkDir,
      defaultConfigPath: absentDefaultCfg,
    })
    expect(code).toBe(0)
    // The validator from co-zdn.7.1 must accept the generated config.
    const loaded = loadConfig(cfgPath, { strict: true })
    expect(loaded.version).toBe(1)
    expect(loaded.proxy?.upstreams).toEqual([{
      name: expected.name,
      base_url: expected.base_url,
      match: { path_prefix: expected.path_prefix },
    }])
    expect(loaded.sink).toEqual({ type: 'file', dir: sinkDir })
  })

  it('chains into runInstall with --yes when daemon + Claude Code accepted', async function() {
    const stdout = memo()
    const stderr = memo()
    const cfgPath = path.join(tmpDir, 'collectivus.json')
    const { prompt } = scriptedPrompt([
      '1', '1', '', '', '', cfgPath, 'y', // proxy / anthropic / defaults / no upload / write
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
      '1', '1', '', '', '', cfgPath, 'y',
      'y',
      'n',
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
      '1', '1', '', '', '', cfgPath, 'y',
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
      '1', '1', '', '', '', cfgPath, 'n',
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

  it('re-prompts on invalid mode answer until a valid one is given', async function() {
    const stdout = memo()
    const stderr = memo()
    const cfgPath = path.join(tmpDir, 'cfg.json')
    const { prompt, asked } = scriptedPrompt([
      'oops', '7', '', // two bad answers, then accept the default (1 = proxy only)
      '1', '', '', // anthropic / default listen / default sink
      '', // no S3 upload
      cfgPath, 'y', 'n',
    ])
    const code = await runInit({
      stdout, stderr, prompt,
      platform: 'darwin',
      cwd: tmpDir,
      defaultConfigPath: absentDefaultCfg,
    })
    expect(code).toBe(0)
    expect(stderr.value()).toMatch(/please choose 1, 2, 3, 4, or 5 \(got "oops"\)/)
    expect(stderr.value()).toMatch(/please choose 1, 2, 3, 4, or 5 \(got "7"\)/)
    // Three "Choose [1]" prompts: two rejected, one accepted via empty input.
    expect(asked.filter(function(q) { return q === 'Choose [1]: ' })).toHaveLength(3)
    expect(fs.existsSync(cfgPath)).toBe(true)
  })

  it('re-prompts on invalid provider choice until a valid one is given', async function() {
    const stdout = memo()
    const stderr = memo()
    const cfgPath = path.join(tmpDir, 'cfg.json')
    const { prompt, asked } = scriptedPrompt([
      '1', // proxy only
      '99', 'nah', '2', // two bad provider answers, then OpenAI
      '', '', // default proxy listen / default sink
      '', // no S3 upload
      cfgPath, 'y', 'n',
    ])
    const code = await runInit({
      stdout, stderr, prompt,
      platform: 'darwin',
      cwd: tmpDir,
      defaultConfigPath: absentDefaultCfg,
    })
    expect(code).toBe(0)
    expect(stderr.value()).toMatch(/invalid provider choice "99"/)
    expect(stderr.value()).toMatch(/invalid provider choice "nah"/)
    expect(asked.filter(function(q) { return q === 'Provider [1]: ' })).toHaveLength(3)
    const written = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    const openai = written.proxy.upstreams.find(
      /**
       * @param {{ name: string }} u
       * @returns {boolean}
       */
      function(u) { return u.name === 'openai' }
    )
    expect(openai.base_url).toBe('https://api.openai.com')
  })

  it('re-prompts when custom upstream base URL is empty', async function() {
    const stdout = memo()
    const stderr = memo()
    const cfgPath = path.join(tmpDir, 'cfg.json')
    const { prompt } = scriptedPrompt([
      '1', '4',
      '', '', // two empty base URLs
      'https://api.example.com',
      '', // default prefix
      '', // default upstream name (derived from URL → 'example')
      '', '', // default proxy listen / default sink
      '', // no S3 upload
      cfgPath, 'y', 'n',
    ])
    const code = await runInit({
      stdout, stderr, prompt,
      platform: 'darwin',
      cwd: tmpDir,
      defaultConfigPath: absentDefaultCfg,
    })
    expect(code).toBe(0)
    expect(stderr.value().match(/base URL is required/g)).toHaveLength(2)
    const written = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    expect(written.proxy.upstreams[0].base_url).toBe('https://api.example.com')
  })

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
    // Did not ask the mode/provider questions.
    expect(asked.some(function(q) { return /What would you like collectivus to do/.test(q) })).toBe(false)
    expect(asked.some(function(q) { return /Provider \[1\]/.test(q) })).toBe(false)
  })

  it('skips daemon install offer when running via npx and prints global-install hint', async function() {
    const stdout = memo()
    const stderr = memo()
    const cfgPath = path.join(tmpDir, 'cfg.json')
    const { prompt, asked } = scriptedPrompt([
      '1', '1', '', '', // proxy / anthropic / default listen / default sink
      '', // no S3 upload
      cfgPath, 'y',
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
    expect(stdout.value()).toMatch(/npx collectivus --config/)
    expect(stdout.value()).toMatch(/npm install -g collectivus/)
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
    expect(stdout.value()).toMatch(/npx collectivus --config/)
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
      'new', // reject reuse
      '1', '1', '', '', // proxy / anthropic / default listen / default sink
      '', // no S3 upload
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

  it('S3 upload yes-path with all defaults produces a valid upload block', async function() {
    const stdout = memo()
    const stderr = memo()
    const cfgPath = path.join(tmpDir, 'cfg.json')
    const sinkDir = path.join(tmpDir, 'sink')
    const { prompt } = scriptedPrompt([
      '1', '1', '', '', // proxy / anthropic / default listen / default sink
      'y', // upload? yes
      'my-llm-logs', // bucket
      '', // default region
      '', // default prefix
      '', // default time
      '', // default signals
      '', // empty endpoint (no MinIO)
      cfgPath,
      'y', // confirm write
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
    expect(written.upload).toEqual({
      bucket: 'my-llm-logs',
      region: 'us-east-1',
      prefix: 'collectivus',
      time: '00:10',
      signals: ['logs', 'traces', 'metrics'],
    })
    // Validator from co-zdn.7.1 must accept the generated config (round-trip).
    const loaded = loadConfig(cfgPath, { strict: true })
    expect(loaded.upload?.bucket).toBe('my-llm-logs')
    // Closing summary surfaces the env-var requirement when upload is set.
    expect(stdout.value()).toMatch(/Upload requires AWS_ACCESS_KEY_ID/)
  })

  it('S3 upload accepts custom region, prefix, time, signal subset, and MinIO endpoint', async function() {
    const stdout = memo()
    const stderr = memo()
    const cfgPath = path.join(tmpDir, 'cfg.json')
    const { prompt } = scriptedPrompt([
      '1', '1', '', '', // proxy / anthropic / defaults
      'yes', // upload
      'long-term-storage',
      'eu-west-1',
      '/team-a/llm/', // prefix with surrounding slashes (should be stripped)
      '03:30',
      'logs, traces', // subset, with whitespace
      'https://minio.example.com:9000',
      cfgPath,
      'y',
      'n',
    ])
    const code = await runInit({
      stdout, stderr, prompt,
      platform: 'darwin',
      cwd: tmpDir,
      defaultConfigPath: absentDefaultCfg,
    })
    expect(code).toBe(0)
    const written = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    expect(written.upload).toEqual({
      bucket: 'long-term-storage',
      region: 'eu-west-1',
      prefix: 'team-a/llm',
      time: '03:30',
      signals: ['logs', 'traces'],
      endpoint: 'https://minio.example.com:9000',
    })
    // Validator must accept it.
    expect(() => loadConfig(cfgPath, { strict: true })).not.toThrow()
  })

  it('S3 upload re-prompts on invalid bucket name', async function() {
    const stdout = memo()
    const stderr = memo()
    const cfgPath = path.join(tmpDir, 'cfg.json')
    const { prompt } = scriptedPrompt([
      '1', '1', '', '',
      'y',
      '', // empty bucket → reject
      'My_Bucket', // uppercase + underscore → reject
      'ab', // too short → reject
      'good-bucket', // accepted
      '', '', '', '', '', // remaining defaults / empty endpoint
      cfgPath, 'y', 'n',
    ])
    const code = await runInit({
      stdout, stderr, prompt,
      platform: 'darwin',
      cwd: tmpDir,
      defaultConfigPath: absentDefaultCfg,
    })
    expect(code).toBe(0)
    const written = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    expect(written.upload.bucket).toBe('good-bucket')
    // Each rejection must surface the spec-mandated error message.
    expect(stderr.value().match(/bucket name must be 3–63 chars/g) ?? []).toHaveLength(3)
  })

  it('S3 upload re-prompts on invalid time', async function() {
    const stdout = memo()
    const stderr = memo()
    const cfgPath = path.join(tmpDir, 'cfg.json')
    const { prompt } = scriptedPrompt([
      '1', '1', '', '',
      'y',
      'mybucket',
      '', // region
      '', // prefix
      '24:00', // out of range (hours 00..23)
      '9:00', // missing leading zero on hour
      '03:30', // valid
      '', '', // signals / endpoint
      cfgPath, 'y', 'n',
    ])
    const code = await runInit({
      stdout, stderr, prompt,
      platform: 'darwin',
      cwd: tmpDir,
      defaultConfigPath: absentDefaultCfg,
    })
    expect(code).toBe(0)
    const written = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    expect(written.upload.time).toBe('03:30')
    expect(stderr.value()).toMatch(/time must be HH:MM/)
  })

  it('S3 upload re-prompts on invalid signal name', async function() {
    const stdout = memo()
    const stderr = memo()
    const cfgPath = path.join(tmpDir, 'cfg.json')
    const { prompt } = scriptedPrompt([
      '1', '1', '', '',
      'y',
      'mybucket',
      '', '', '', // region / prefix / time
      'logs,events', // 'events' isn't allowed
      'logs', // accepted
      '', // endpoint
      cfgPath, 'y', 'n',
    ])
    const code = await runInit({
      stdout, stderr, prompt,
      platform: 'darwin',
      cwd: tmpDir,
      defaultConfigPath: absentDefaultCfg,
    })
    expect(code).toBe(0)
    const written = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    expect(written.upload.signals).toEqual(['logs'])
    expect(stderr.value()).toMatch(/signals must be a comma-separated subset/)
  })

  it('S3 upload re-prompts on unparseable endpoint URL', async function() {
    const stdout = memo()
    const stderr = memo()
    const cfgPath = path.join(tmpDir, 'cfg.json')
    const { prompt } = scriptedPrompt([
      '1', '1', '', '',
      'y',
      'mybucket',
      '', '', '', '',
      'not a url', // reject
      'https://s3.example.com', // accept
      cfgPath, 'y', 'n',
    ])
    const code = await runInit({
      stdout, stderr, prompt,
      platform: 'darwin',
      cwd: tmpDir,
      defaultConfigPath: absentDefaultCfg,
    })
    expect(code).toBe(0)
    const written = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    expect(written.upload.endpoint).toBe('https://s3.example.com')
    expect(stderr.value()).toMatch(/endpoint must be a valid URL/)
  })

  it('declining S3 upload omits the upload block and skips the env-var notice', async function() {
    const stdout = memo()
    const stderr = memo()
    const cfgPath = path.join(tmpDir, 'cfg.json')
    const { prompt } = scriptedPrompt([
      '1', '1', '', '',
      'n', // explicit no
      cfgPath, 'y', 'n',
    ])
    const code = await runInit({
      stdout, stderr, prompt,
      platform: 'darwin',
      cwd: tmpDir,
      defaultConfigPath: absentDefaultCfg,
    })
    expect(code).toBe(0)
    const written = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    expect(written.upload).toBeUndefined()
    expect(stdout.value()).not.toMatch(/Upload requires/)
  })

  it('printConfigSummary renders an upload line for an existing config with upload', async function() {
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
        bucket: 'my-llm-logs',
        prefix: 'collectivus',
        region: 'us-east-1',
        time: '00:10',
        signals: ['logs', 'traces', 'metrics'],
      },
    }
    const { prompt } = scriptedPrompt([
      'use', // reuse existing
      'n', // decline daemon install
    ])
    const code = await runInit({
      stdout, stderr, prompt,
      platform: 'darwin',
      cwd: tmpDir,
      defaultConfigPath: cfgPath,
      readConfig() { return existing },
    })
    expect(code).toBe(0)
    expect(stdout.value()).toMatch(/upload: s3:\/\/my-llm-logs\/collectivus daily at 00:10 UTC/)
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
      'use', // reuse explicitly
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

  describe('gateway-mode walkthrough (mode 4)', function() {
    it('writes a valid role:gateway config with central_server + poll_interval_seconds', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'gw.json')
      const sinkDir = path.join(tmpDir, 'gw-sink')
      const { prompt, asked } = scriptedPrompt([
        '4', // gateway mode
        'https://central.example.com:8788', // central server URL
        '60', // poll_interval_seconds override
        '1', // capture mode: proxy only
        '1', // anthropic
        '', // default proxy listen
        sinkDir,
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
      expect(written.otel).toBeUndefined()
      // Validates against the loader (round-trips through validateConfig).
      const loaded = loadConfig(cfgPath)
      expect(loaded.role).toBe('gateway')
      // Closing summary points at the operator step.
      expect(stdout.value()).toMatch(/collectivus config set <gateway-id>/)
      expect(stdout.value()).toMatch(/before this gateway will see anything to load/)
      expect(stdout.value()).toMatch(/bootstrap_token in/)
      // Did NOT collect the bootstrap token interactively.
      expect(asked.some(function(q) { return /bootstrap.token/i.test(q) })).toBe(false)
    })

    it('omits poll_interval_seconds when the user accepts the default', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'gw.json')
      const { prompt } = scriptedPrompt([
        '4', // gateway mode
        'https://central.example.com:8788',
        '', // accept default poll interval (omitted from config)
        '2', // capture: otel only
        '127.0.0.1:4319', // otel listen override
        path.join(tmpDir, 'gw-sink'),
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
        '4',
        'https://central.example.com:8788',
        '0', // below 5 — rejected
        '4000', // above 3600 — rejected
        'banana', // not a number — rejected
        '15', // valid
        '1', // capture: proxy only
        '1', '', // anthropic, default listen
        path.join(tmpDir, 'gw-sink'),
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
      // Four "Poll interval" prompts: three rejected, one accepted.
      expect(asked.filter(function(q) { return q.startsWith('Poll interval') })).toHaveLength(4)
    })

    it('re-prompts on invalid central server URL', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'gw.json')
      const { prompt, asked } = scriptedPrompt([
        '4',
        '', // empty rejected
        'not a url', // unparseable rejected
        'https://central.example.com:8788',
        '', // default poll interval
        '1', // capture proxy
        '1', '', // anthropic, default listen
        path.join(tmpDir, 'gw-sink'),
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

  describe('server-mode walkthrough (mode 5)', function() {
    it('writes a valid role:server config with the operator-supplied data_dir', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'server.json')
      const dataDir = path.join(tmpDir, 'server-data')
      const { prompt } = scriptedPrompt([
        '5', // server mode
        '', // accept default control-plane listen
        dataDir, // server data directory
        '', // generate identity-issuer secret
        '', // no S3 upload (default N)
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
      expect(written.server.data_dir).toBe(dataDir)
      expect(written.server.sink_dir).toBe(path.join(dataDir, 'ingested'))
      expect(written.server.identity_issuer.bootstrap_store_path).toBe(path.join(dataDir, 'bootstrap.json'))
      // Generated secret: 32 random bytes hex-encoded == 64 hex chars.
      expect(typeof written.server.identity_issuer.secret).toBe('string')
      expect(written.server.identity_issuer.secret.length).toBe(64)
      expect(written.server.identity_issuer.secret).toMatch(/^[0-9a-f]+$/)
      // Validator round-trips.
      const loaded = loadConfig(cfgPath)
      expect(loaded.role).toBe('server')
      // Operator next-steps surface the bootstrap-token + config-set commands.
      expect(stdout.value()).toMatch(/collectivus config bootstrap-token issue/)
      expect(stdout.value()).toMatch(/collectivus config set <gateway-id>/)
    })

    it('falls back to a generated secret when the operator-supplied value is too short', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'server.json')
      const { prompt } = scriptedPrompt([
        '5',
        '127.0.0.1:9999', // explicit control-plane listen
        '', // default data_dir
        'too-short', // shorter than 32 chars — must be replaced with generated
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
      expect(written.server.identity_issuer.secret).not.toBe('too-short')
      expect(written.server.identity_issuer.secret.length).toBe(64)
    })

    it('attaches an upload block when the operator opts in', async function() {
      const stdout = memo()
      const stderr = memo()
      const cfgPath = path.join(tmpDir, 'server.json')
      const { prompt } = scriptedPrompt([
        '5',
        '', // default listen
        path.join(tmpDir, 'server-data'),
        '', // generate secret
        'y', // YES upload
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
})
