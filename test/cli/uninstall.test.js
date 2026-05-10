import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseUninstallArgs, runUninstall } from '../../src/cli/uninstall.js'

/**
 * @import { UninstallCall, DetachCall, UninstallMocks } from '../types.js'
 */

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-uninstall-'))
})
afterEach(function() {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/**
 * @param {{
 *   uninstallError?: Error,
 *   detachError?: Error,
 *   detachResult?: { changed: boolean, removed?: string, warning?: string },
 *   codexDetachError?: Error,
 *   codexDetachResult?: { changed: boolean, removed?: string, restoredValue?: string, warning?: string },
 *   isAttachedResult?: boolean,
 *   isAttachedError?: Error,
 *   isCodexAttachedResult?: boolean,
 *   isCodexAttachedError?: Error,
 * }} [opts]
 * @returns {UninstallMocks}
 */
function makeMocks(opts = {}) {
  /** @type {UninstallCall[]} */
  const uninstallCalls = []
  /** @type {DetachCall[]} */
  const detachCalls = []
  /** @type {DetachCall[]} */
  const codexDetachCalls = []
  return {
    uninstallCalls,
    detachCalls,
    codexDetachCalls,
    uninstallLaunchAgent(o) {
      uninstallCalls.push({ ...o })
      if (opts.uninstallError) return Promise.reject(opts.uninstallError)
      return Promise.resolve()
    },
    detach(o) {
      detachCalls.push({ ...o })
      if (opts.detachError) return Promise.reject(opts.detachError)
      return Promise.resolve(opts.detachResult ?? { changed: true, removed: 'http://127.0.0.1:8787' })
    },
    detachCodex(o) {
      codexDetachCalls.push({ ...o })
      if (opts.codexDetachError) return Promise.reject(opts.codexDetachError)
      return Promise.resolve(opts.codexDetachResult ?? { changed: true, removed: 'http://127.0.0.1:8787/v1' })
    },
    isAttached() {
      if (opts.isAttachedError) return Promise.reject(opts.isAttachedError)
      return Promise.resolve(opts.isAttachedResult ?? true)
    },
    isCodexAttached() {
      if (opts.isCodexAttachedError) return Promise.reject(opts.isCodexAttachedError)
      return Promise.resolve(opts.isCodexAttachedResult ?? true)
    },
  }
}

describe('parseUninstallArgs', function() {
  it('treats no args as no-detach', function() {
    expect(parseUninstallArgs([])).toEqual({ detach: false, help: false, client: 'claude' })
  })

  it('parses --detach', function() {
    expect(parseUninstallArgs(['--detach']).detach).toBe(true)
  })

  it('parses --client <name>', function() {
    expect(parseUninstallArgs(['--client', 'codex'])).toMatchObject({
      detach: false, client: 'codex',
    })
    expect(parseUninstallArgs(['--detach', '--client=all'])).toMatchObject({
      detach: true, client: 'all',
    })
  })

  it('rejects unknown --client values', function() {
    expect(parseUninstallArgs(['--client', 'zed']).error).toMatch(/expected claude, codex, or all/)
  })

  it('returns help mode for --help / -h', function() {
    expect(parseUninstallArgs(['--help']).help).toBe(true)
    expect(parseUninstallArgs(['-h']).help).toBe(true)
  })

  it('rejects unknown args', function() {
    expect(parseUninstallArgs(['--mystery']).error).toMatch(/unknown argument/)
  })
})

describe('runUninstall', function() {
  it('prints help and exits 0 on --help', async function() {
    const stdout = memo()
    const stderr = memo()
    const code = await runUninstall(['--help'], { stdout, stderr })
    expect(code).toBe(0)
    expect(stdout.value()).toMatch(/Usage:/)
  })

  it('exits 2 on bad args', async function() {
    const stdout = memo()
    const stderr = memo()
    const code = await runUninstall(['--mystery'], { stdout, stderr })
    expect(code).toBe(2)
    expect(stderr.value()).toMatch(/unknown argument/)
  })

  it('--detach uninstalls and reverts without prompting', async function() {
    const stdout = memo()
    const stderr = memo()
    const m = makeMocks()
    /** @type {string[]} */
    const promptCalls = []
    const code = await runUninstall(['--detach'], {
      stdout, stderr,
      settingsPath: path.join(tmpDir, 'settings.json'),
      uninstallLaunchAgent: m.uninstallLaunchAgent,
      detach: m.detach,
      isAttached: m.isAttached,
      prompt(q) { promptCalls.push(q); return Promise.resolve('') },
      isTTY: true,
    })
    expect(code).toBe(0)
    expect(promptCalls).toHaveLength(0)
    expect(m.uninstallCalls).toEqual([{ label: 'com.hyparam.collectivus' }])
    expect(m.detachCalls).toEqual([{ settingsPath: path.join(tmpDir, 'settings.json') }])
    expect(stdout.value()).toMatch(/Daemon removed/)
    expect(stdout.value()).toMatch(/Claude Code reverted/)
  })

  it('--detach --client codex uninstalls and reverts Codex without touching Claude Code', async function() {
    const stdout = memo()
    const stderr = memo()
    const m = makeMocks()
    const code = await runUninstall(['--detach', '--client', 'codex'], {
      stdout, stderr,
      settingsPath: path.join(tmpDir, 'settings.json'),
      codexConfigPath: path.join(tmpDir, 'config.toml'),
      uninstallLaunchAgent: m.uninstallLaunchAgent,
      detach: m.detach,
      detachCodex: m.detachCodex,
      isAttached: m.isAttached,
      isCodexAttached: m.isCodexAttached,
    })
    expect(code).toBe(0)
    expect(m.uninstallCalls).toEqual([{ label: 'com.hyparam.collectivus' }])
    expect(m.detachCalls).toEqual([])
    expect(m.codexDetachCalls).toEqual([{ configPath: path.join(tmpDir, 'config.toml') }])
    expect(stdout.value()).toMatch(/Daemon removed/)
    expect(stdout.value()).toMatch(/Codex reverted/)
  })

  it('--detach --client all uninstalls and reverts Claude Code and Codex', async function() {
    const stdout = memo()
    const stderr = memo()
    const m = makeMocks({ codexDetachResult: { changed: true, restoredValue: 'openai' } })
    const code = await runUninstall(['--detach', '--client', 'all'], {
      stdout, stderr,
      settingsPath: path.join(tmpDir, 'settings.json'),
      codexConfigPath: path.join(tmpDir, 'config.toml'),
      uninstallLaunchAgent: m.uninstallLaunchAgent,
      detach: m.detach,
      detachCodex: m.detachCodex,
      isAttached: m.isAttached,
      isCodexAttached: m.isCodexAttached,
    })
    expect(code).toBe(0)
    expect(m.detachCalls).toEqual([{ settingsPath: path.join(tmpDir, 'settings.json') }])
    expect(m.codexDetachCalls).toEqual([{ configPath: path.join(tmpDir, 'config.toml') }])
    expect(stdout.value()).toMatch(/Claude Code reverted/)
    expect(stdout.value()).toMatch(/Codex reverted/)
    expect(stdout.value()).toMatch(/Restored model_provider=openai/)
  })

  it('TTY without --detach: prompts and reverts on yes', async function() {
    const stdout = memo()
    const stderr = memo()
    const m = makeMocks({ isAttachedResult: true })
    const code = await runUninstall([], {
      stdout, stderr,
      settingsPath: path.join(tmpDir, 'settings.json'),
      uninstallLaunchAgent: m.uninstallLaunchAgent,
      detach: m.detach,
      isAttached: m.isAttached,
      prompt() { return Promise.resolve('y') },
      isTTY: true,
    })
    expect(code).toBe(0)
    expect(m.detachCalls).toHaveLength(1)
  })

  it('TTY without --detach: empty answer reverts (Y default)', async function() {
    const stdout = memo()
    const stderr = memo()
    const m = makeMocks({ isAttachedResult: true })
    const code = await runUninstall([], {
      stdout, stderr,
      settingsPath: path.join(tmpDir, 'settings.json'),
      uninstallLaunchAgent: m.uninstallLaunchAgent,
      detach: m.detach,
      isAttached: m.isAttached,
      prompt() { return Promise.resolve('') },
      isTTY: true,
    })
    expect(code).toBe(0)
    expect(m.detachCalls).toHaveLength(1)
  })

  it('TTY without --detach: explicit no skips revert', async function() {
    const stdout = memo()
    const stderr = memo()
    const m = makeMocks({ isAttachedResult: true })
    const code = await runUninstall([], {
      stdout, stderr,
      settingsPath: path.join(tmpDir, 'settings.json'),
      uninstallLaunchAgent: m.uninstallLaunchAgent,
      detach: m.detach,
      isAttached: m.isAttached,
      prompt() { return Promise.resolve('n') },
      isTTY: true,
    })
    expect(code).toBe(0)
    expect(m.uninstallCalls).toHaveLength(1)
    expect(m.detachCalls).toHaveLength(0)
    expect(stdout.value()).toMatch(/Claude Code revert: skipped/)
  })

  it('non-TTY without --detach skips silently with a warning', async function() {
    const stdout = memo()
    const stderr = memo()
    const m = makeMocks({ isAttachedResult: true })
    /** @type {string[]} */
    const promptCalls = []
    const code = await runUninstall([], {
      stdout, stderr,
      settingsPath: path.join(tmpDir, 'settings.json'),
      uninstallLaunchAgent: m.uninstallLaunchAgent,
      detach: m.detach,
      isAttached: m.isAttached,
      prompt(q) { promptCalls.push(q); return Promise.resolve('') },
      isTTY: false,
    })
    expect(code).toBe(0)
    expect(promptCalls).toHaveLength(0)
    expect(m.detachCalls).toHaveLength(0)
    expect(stderr.value()).toMatch(/not a TTY/)
  })

  it('non-TTY --client codex without --detach warns with the Codex detach command', async function() {
    const stdout = memo()
    const stderr = memo()
    const m = makeMocks({ isCodexAttachedResult: true })
    const code = await runUninstall(['--client', 'codex'], {
      stdout, stderr,
      codexConfigPath: path.join(tmpDir, 'config.toml'),
      uninstallLaunchAgent: m.uninstallLaunchAgent,
      detachCodex: m.detachCodex,
      isCodexAttached: m.isCodexAttached,
      isTTY: false,
    })
    expect(code).toBe(0)
    expect(m.detachCalls).toHaveLength(0)
    expect(m.codexDetachCalls).toHaveLength(0)
    expect(stderr.value()).toMatch(/collectivus detach --client codex/)
  })

  it('skips revert prompt when settings.json has no marker', async function() {
    const stdout = memo()
    const stderr = memo()
    const m = makeMocks({ isAttachedResult: false })
    /** @type {string[]} */
    const promptCalls = []
    const code = await runUninstall([], {
      stdout, stderr,
      settingsPath: path.join(tmpDir, 'settings.json'),
      uninstallLaunchAgent: m.uninstallLaunchAgent,
      detach: m.detach,
      isAttached: m.isAttached,
      prompt(q) { promptCalls.push(q); return Promise.resolve('') },
      isTTY: true,
    })
    expect(code).toBe(0)
    expect(promptCalls).toHaveLength(0)
    expect(m.detachCalls).toHaveLength(0)
    expect(stdout.value()).toMatch(/not attached, nothing to revert/)
  })

  it('forwards --detach even when isAttached returns false', async function() {
    const stdout = memo()
    const stderr = memo()
    const m = makeMocks({
      isAttachedResult: false,
      detachResult: { changed: false },
    })
    const code = await runUninstall(['--detach'], {
      stdout, stderr,
      settingsPath: path.join(tmpDir, 'settings.json'),
      uninstallLaunchAgent: m.uninstallLaunchAgent,
      detach: m.detach,
      isAttached: m.isAttached,
      isTTY: true,
    })
    expect(code).toBe(0)
    expect(m.detachCalls).toHaveLength(1)
    expect(stdout.value()).toMatch(/no marker found/)
  })

  it('exits 1 when uninstallDaemon fails', async function() {
    const stdout = memo()
    const stderr = memo()
    const m = makeMocks({ uninstallError: new Error('boom') })
    const code = await runUninstall(['--detach'], {
      stdout, stderr,
      settingsPath: path.join(tmpDir, 'settings.json'),
      uninstallLaunchAgent: m.uninstallLaunchAgent,
      detach: m.detach,
      isAttached: m.isAttached,
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/failed to uninstall daemon.*boom/)
    expect(m.detachCalls).toHaveLength(0)
  })

  it('exits 1 when detach fails after uninstall', async function() {
    const stdout = memo()
    const stderr = memo()
    const m = makeMocks({ detachError: new Error('settings unreadable') })
    const code = await runUninstall(['--detach'], {
      stdout, stderr,
      settingsPath: path.join(tmpDir, 'settings.json'),
      uninstallLaunchAgent: m.uninstallLaunchAgent,
      detach: m.detach,
      isAttached: m.isAttached,
    })
    expect(code).toBe(1)
    expect(m.uninstallCalls).toHaveLength(1)
    expect(stderr.value()).toMatch(/failed to revert Claude Code/)
  })

  it('surfaces detach warnings when ANTHROPIC_BASE_URL is overridden', async function() {
    const stdout = memo()
    const stderr = memo()
    const m = makeMocks({
      detachResult: { changed: true, warning: 'ANTHROPIC_BASE_URL was overridden externally; leaving in place' },
    })
    const code = await runUninstall(['--detach'], {
      stdout, stderr,
      settingsPath: path.join(tmpDir, 'settings.json'),
      uninstallLaunchAgent: m.uninstallLaunchAgent,
      detach: m.detach,
      isAttached: m.isAttached,
    })
    expect(code).toBe(0)
    expect(stdout.value()).toMatch(/warning: ANTHROPIC_BASE_URL was overridden/)
  })
})
