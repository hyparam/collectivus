import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { DaemonError, installDaemon, uninstallDaemon } from '../../src/daemon/index.js'

/** @type {string} */
let tmpDir

beforeEach(function() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-daemon-idx-'))
})

afterEach(function() {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

const ok = { exitCode: 0, stdout: '', stderr: '' }
const notLoaded = { exitCode: 113, stdout: '', stderr: '' }

/**
 * @returns {{ calls: string[], adapter: import('../../src/daemon/macos.js').LaunchctlAdapter }}
 */
function makeRecordingLaunchctl() {
  /** @type {string[]} */
  const calls = []
  return {
    calls,
    adapter: {
      load(p) { calls.push(`load ${p}`); return Promise.resolve(ok) },
      unload(p) { calls.push(`unload ${p}`); return Promise.resolve(ok) },
      list(l) { calls.push(`list ${l}`); return Promise.resolve(notLoaded) },
    },
  }
}

/**
 * Run `fn` with `process.platform` temporarily set to `value`, restoring the
 * original descriptor afterward (process.platform is a non-writable getter
 * by default, hence the defineProperty dance).
 *
 * @param {NodeJS.Platform} value
 * @param {() => Promise<void> | void} fn
 * @returns {Promise<void>}
 */
async function withPlatform(value, fn) {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value, configurable: true, writable: true })
  try {
    await fn()
  } finally {
    if (original) Object.defineProperty(process, 'platform', original)
  }
}

describe('installDaemon / uninstallDaemon', () => {
  it('throws DaemonError on non-darwin platforms', async () => {
    await withPlatform('linux', async () => {
      await expect(installDaemon({
        label: 'l', binPath: 'b', configPath: 'c', logDir: tmpDir,
      })).rejects.toThrow(DaemonError)
      await expect(uninstallDaemon({ label: 'l' })).rejects.toThrow(/unsupported platform: linux/)
    })
  })

  it('dispatches to the macos backend on darwin', async () => {
    const fake = makeRecordingLaunchctl()
    const plistDir = path.join(tmpDir, 'plists')

    await withPlatform('darwin', async () => {
      await installDaemon({
        label: 'com.test.dispatch',
        binPath: '/bin/x',
        configPath: '/etc/x.json',
        logDir: tmpDir,
        plistDir,
        launchctl: fake.adapter,
      })
    })
    expect(fake.calls).toContain('load ' + path.join(plistDir, 'com.test.dispatch.plist'))
  })
})
