import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseUninstallArgs, runUninstall } from './uninstall.js'

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
 * @typedef {object} UninstallCall
 * @property {string} label
 * @property {string} [plistDir]
 */

/**
 * @typedef {object} DetachCall
 * @property {string} settingsPath
 */

/**
 * @typedef {object} Mocks
 * @property {UninstallCall[]} uninstallCalls
 * @property {DetachCall[]} detachCalls
 * @property {(opts: any) => Promise<void>} uninstallLaunchAgent
 * @property {(opts: any) => Promise<{ changed: boolean, removed?: string, warning?: string }>} detach
 * @property {(opts: any) => Promise<boolean>} isAttached
 */

/**
 * @param {{
 *   uninstallError?: Error,
 *   detachError?: Error,
 *   detachResult?: { changed: boolean, removed?: string, warning?: string },
 *   isAttachedResult?: boolean,
 *   isAttachedError?: Error,
 * }} [opts]
 * @returns {Mocks}
 */
function makeMocks(opts = {}) {
  /** @type {UninstallCall[]} */
  const uninstallCalls = []
  /** @type {DetachCall[]} */
  const detachCalls = []
  return {
    uninstallCalls,
    detachCalls,
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
    isAttached() {
      if (opts.isAttachedError) return Promise.reject(opts.isAttachedError)
      return Promise.resolve(opts.isAttachedResult ?? true)
    },
  }
}

describe('parseUninstallArgs', function() {
  it('treats no args as no-detach', function() {
    expect(parseUninstallArgs([])).toEqual({ detach: false, help: false, error: null })
  })

  it('parses --detach', function() {
    expect(parseUninstallArgs(['--detach']).detach).toBe(true)
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
