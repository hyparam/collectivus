import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SettingsError } from '../claude-code/settings.js'
import { parseStatusArgs, runStatus } from './status.js'

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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-status-'))
})
afterEach(function() {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('parseStatusArgs', function() {
  it('treats no args as default', function() {
    expect(parseStatusArgs([])).toEqual({ help: false, error: null })
  })

  it('returns help mode for --help', function() {
    expect(parseStatusArgs(['--help']).help).toBe(true)
    expect(parseStatusArgs(['-h']).help).toBe(true)
  })

  it('rejects unknown args', function() {
    expect(parseStatusArgs(['--mystery']).error).toMatch(/unknown argument/)
  })
})

describe('runStatus', function() {
  it('prints help on --help', async function() {
    const stdout = memo()
    const code = await runStatus(['--help'], { stdout, stderr: memo() })
    expect(code).toBe(0)
    expect(stdout.value()).toMatch(/Usage:/)
  })

  it('exits 2 on bad args', async function() {
    const stderr = memo()
    const code = await runStatus(['--mystery'], { stdout: memo(), stderr })
    expect(code).toBe(2)
    expect(stderr.value()).toMatch(/unknown argument/)
  })

  it('reports daemon not installed and Claude Code not attached', async function() {
    const stdout = memo()
    const stderr = memo()
    const code = await runStatus([], {
      stdout, stderr,
      plistPath: path.join(tmpDir, 'plist'),
      settingsPath: path.join(tmpDir, 'settings.json'),
      logDir: path.join(tmpDir, 'logs'),
      isLaunchAgentInstalled() { return Promise.resolve(false) },
      launchAgentStatus() { return Promise.resolve({ loaded: false }) },
      isAttached() { return Promise.resolve(false) },
      readInstalledPlist() { return null },
      readSettingsRaw() { return Promise.resolve(null) },
    })
    expect(code).toBe(0)
    const out = stdout.value()
    expect(out).toMatch(/Daemon/)
    expect(out).toMatch(/Status: not installed/)
    expect(out).toMatch(/Claude Code/)
    expect(out).toMatch(/Status: not attached/)
  })

  it('reports daemon loaded with PID and config from plist', async function() {
    const stdout = memo()
    const code = await runStatus([], {
      stdout, stderr: memo(),
      plistPath: path.join(tmpDir, 'plist'),
      settingsPath: path.join(tmpDir, 'settings.json'),
      logDir: path.join(tmpDir, 'logs'),
      isLaunchAgentInstalled() { return Promise.resolve(true) },
      launchAgentStatus() { return Promise.resolve({ loaded: true, pid: 4242 }) },
      isAttached() { return Promise.resolve(false) },
      readInstalledPlist() {
        return {
          configPath: '/etc/collectivus.json',
          stdoutPath: '/var/log/collectivus.log',
          stderrPath: '/var/log/collectivus.err.log',
        }
      },
      readSettingsRaw() { return Promise.resolve(null) },
    })
    expect(code).toBe(0)
    const out = stdout.value()
    expect(out).toMatch(/Status: loaded \(PID 4242\)/)
    expect(out).toMatch(/Config: \/etc\/collectivus\.json/)
    expect(out).toMatch(/stdout: \/var\/log\/collectivus\.log/)
    expect(out).toMatch(/stderr: \/var\/log\/collectivus\.err\.log/)
  })

  it('reports loaded without PID gracefully', async function() {
    const stdout = memo()
    const code = await runStatus([], {
      stdout, stderr: memo(),
      plistPath: path.join(tmpDir, 'plist'),
      settingsPath: path.join(tmpDir, 'settings.json'),
      logDir: path.join(tmpDir, 'logs'),
      isLaunchAgentInstalled() { return Promise.resolve(true) },
      launchAgentStatus() { return Promise.resolve({ loaded: true }) },
      isAttached() { return Promise.resolve(false) },
      readInstalledPlist() { return { configPath: null, stdoutPath: null, stderrPath: null } },
      readSettingsRaw() { return Promise.resolve(null) },
    })
    expect(code).toBe(0)
    expect(stdout.value()).toMatch(/loaded \(no PID/)
  })

  it('falls back to default log paths when plist parsing returns nulls', async function() {
    const stdout = memo()
    const logDir = path.join(tmpDir, 'logs')
    const code = await runStatus([], {
      stdout, stderr: memo(),
      plistPath: path.join(tmpDir, 'plist'),
      settingsPath: path.join(tmpDir, 'settings.json'),
      logDir,
      isLaunchAgentInstalled() { return Promise.resolve(true) },
      launchAgentStatus() { return Promise.resolve({ loaded: true, pid: 1 }) },
      isAttached() { return Promise.resolve(false) },
      readInstalledPlist() { return { configPath: null, stdoutPath: null, stderrPath: null } },
      readSettingsRaw() { return Promise.resolve(null) },
    })
    expect(code).toBe(0)
    const out = stdout.value()
    expect(out).toMatch(new RegExp(`stdout: ${logDir.replace(/\//g, '\\/')}\\/collectivus\\.log`))
    expect(out).toMatch(new RegExp(`stderr: ${logDir.replace(/\//g, '\\/')}\\/collectivus\\.err\\.log`))
  })

  it('reports Claude Code attached and parses marker', async function() {
    const stdout = memo()
    const settingsPath = path.join(tmpDir, 'settings.json')
    fs.writeFileSync(settingsPath, JSON.stringify({
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787' },
      _collectivus: { attached_at: '2026-01-02T03:04:05.000Z', version: '1.2.3', port: 8787 },
    }))
    const code = await runStatus([], {
      stdout, stderr: memo(),
      plistPath: path.join(tmpDir, 'plist'),
      settingsPath,
      logDir: path.join(tmpDir, 'logs'),
      isLaunchAgentInstalled() { return Promise.resolve(false) },
      launchAgentStatus() { return Promise.resolve({ loaded: false }) },
      isAttached() { return Promise.resolve(true) },
      readInstalledPlist() { return null },
    })
    expect(code).toBe(0)
    const out = stdout.value()
    expect(out).toMatch(/Status: attached/)
    expect(out).toMatch(/Attached at: 2026-01-02T03:04:05\.000Z/)
    expect(out).toMatch(/Port: 8787/)
    expect(out).toMatch(/Marker version: 1\.2\.3/)
  })

  it('exits 1 when settings.json is malformed (isAttached throws)', async function() {
    const stdout = memo()
    const stderr = memo()
    const code = await runStatus([], {
      stdout, stderr,
      plistPath: path.join(tmpDir, 'plist'),
      settingsPath: path.join(tmpDir, 'settings.json'),
      logDir: path.join(tmpDir, 'logs'),
      isLaunchAgentInstalled() { return Promise.resolve(false) },
      launchAgentStatus() { return Promise.resolve({ loaded: false }) },
      isAttached() { return Promise.reject(new SettingsError('malformed JSON')) },
      readInstalledPlist() { return null },
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/failed to read.*malformed JSON/)
    expect(stdout.value()).toMatch(/Status: unknown/)
  })

  it('exits 1 when isLaunchAgentInstalled fails', async function() {
    const stdout = memo()
    const stderr = memo()
    const code = await runStatus([], {
      stdout, stderr,
      plistPath: path.join(tmpDir, 'plist'),
      settingsPath: path.join(tmpDir, 'settings.json'),
      logDir: path.join(tmpDir, 'logs'),
      isLaunchAgentInstalled() { return Promise.reject(new Error('disk explode')) },
      launchAgentStatus() { return Promise.resolve({ loaded: false }) },
      isAttached() { return Promise.resolve(false) },
      readInstalledPlist() { return null },
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/failed to check daemon installation.*disk explode/)
  })
})
