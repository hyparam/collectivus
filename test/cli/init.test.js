import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runInit } from '../../src/cli/init.js'

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
    expect(written.proxy).toMatchObject({
      listen: '127.0.0.1:8787',
      upstreams: {
        anthropic: {
          base_url: 'https://api.anthropic.com',
          match: { path_prefix: '/v1/messages' },
        },
      },
    })
    expect(written.proxy.redact_headers).toContain('x-api-key')
    expect(written.sink).toEqual({ type: 'file', dir: sinkDir })
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
    expect(written.proxy.listen).toBe('127.0.0.1:9090')
    expect(written.proxy.upstreams.openai.base_url).toBe('https://api.openai.com')
    expect(written.otel).toEqual({ listen: '0.0.0.0:4317' })
  })

  it('custom upstream prompts for base URL and prefix', async function() {
    const stdout = memo()
    const stderr = memo()
    const cfgPath = path.join(tmpDir, 'cfg.json')
    const { prompt } = scriptedPrompt([
      '1',
      '4', // custom
      'https://api.example.com', // base URL
      '/v2/chat', // prefix
      '', // default proxy listen
      '', // default sink
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
    const written = JSON.parse(fs.readFileSync(cfgPath, 'utf8'))
    expect(written.proxy.upstreams.upstream).toEqual({
      base_url: 'https://api.example.com',
      match: { path_prefix: '/v2/chat' },
    })
  })

  it('chains into runInstall with --yes when daemon + Claude Code accepted', async function() {
    const stdout = memo()
    const stderr = memo()
    const cfgPath = path.join(tmpDir, 'collectivus.json')
    const { prompt } = scriptedPrompt([
      '1', '1', '', '', cfgPath, 'y', // proxy / anthropic / defaults / write
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
      '1', '1', '', '', cfgPath, 'y',
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
      '1', '1', '', '', cfgPath, 'y',
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
      '1', '1', '', '', cfgPath, 'n',
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
      cfgPath, 'y', 'n',
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
    expect(written.proxy.upstreams.openai.base_url).toBe('https://api.openai.com')
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
      '', '', // default proxy listen / default sink
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
    expect(written.proxy.upstreams.upstream.base_url).toBe('https://api.example.com')
  })

  it('reuses an existing config and chains into runInstall', async function() {
    const stdout = memo()
    const stderr = memo()
    const cfgPath = path.join(tmpDir, 'existing.json')
    /** @type {CollectivusConfig} */
    const existing = {
      proxy: {
        listen: '127.0.0.1:8787',
        upstreams: { anthropic: { base_url: 'https://api.anthropic.com', match: { path_prefix: '/v1/messages' } } },
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
      '1', '1', '', '', cfgPath, 'y',
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
      proxy: {
        listen: '127.0.0.1:8787',
        upstreams: { anthropic: { base_url: 'https://api.anthropic.com', match: { path_prefix: '/v1/messages' } } },
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
      proxy: {
        listen: '127.0.0.1:9999',
        upstreams: { anthropic: { base_url: 'https://api.anthropic.com', match: { path_prefix: '/v1/messages' } } },
      },
      sink: { type: 'file', dir: path.join(tmpDir, 'old-sink') },
    }
    const { prompt } = scriptedPrompt([
      'new', // reject reuse
      '1', '1', '', '', // proxy / anthropic / default listen / default sink
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
})
