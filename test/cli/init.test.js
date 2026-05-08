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

  it('custom upstream rejects an invalid slug name', async function() {
    const stdout = memo()
    const stderr = memo()
    const { prompt } = scriptedPrompt([
      '1',
      '4',
      'https://api.example.com',
      '/v2/chat',
      'Bad Name', // invalid: capital + space
    ])
    const code = await runInit({
      stdout, stderr, prompt,
      platform: 'darwin',
      cwd: tmpDir,
      defaultConfigPath: absentDefaultCfg,
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/name must match \[a-z\]\[a-z0-9-\]\*/)
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

  it('exits 1 on invalid mode answer', async function() {
    const stdout = memo()
    const stderr = memo()
    const { prompt } = scriptedPrompt(['7'])
    const code = await runInit({
      stdout, stderr, prompt,
      platform: 'darwin',
      cwd: tmpDir,
      defaultConfigPath: absentDefaultCfg,
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/please choose 1, 2, or 3/)
  })

  it('exits 1 on invalid provider choice', async function() {
    const stdout = memo()
    const stderr = memo()
    const { prompt } = scriptedPrompt(['1', '99'])
    const code = await runInit({
      stdout, stderr, prompt,
      platform: 'darwin',
      cwd: tmpDir,
      defaultConfigPath: absentDefaultCfg,
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/invalid provider choice/)
  })

  it('exits 1 when custom upstream base URL is empty', async function() {
    const stdout = memo()
    const stderr = memo()
    const { prompt } = scriptedPrompt(['1', '4', ''])
    const code = await runInit({
      stdout, stderr, prompt,
      platform: 'darwin',
      cwd: tmpDir,
      defaultConfigPath: absentDefaultCfg,
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/base URL is required/)
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
