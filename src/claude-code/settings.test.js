import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SettingsError, attach, defaultSettingsPath, detach, isAttached } from './settings.js'

/** @type {string} */
let tmpDir
/** @type {string} */
let settingsPath

beforeEach(function() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-settings-'))
  settingsPath = path.join(tmpDir, 'settings.json')
})

afterEach(function() {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/**
 * @param {unknown} value
 */
function writeJson(value) {
  fs.writeFileSync(settingsPath, JSON.stringify(value, null, 2))
}

/**
 * @returns {any}
 */
function readJson() {
  const raw = fs.readFileSync(settingsPath, 'utf8')
  return JSON.parse(raw)
}

describe('defaultSettingsPath', () => {
  it('points at ~/.claude/settings.json', () => {
    expect(defaultSettingsPath()).toBe(path.join(os.homedir(), '.claude', 'settings.json'))
  })
})

describe('attach', () => {
  it('creates a new file when settings.json is missing (and creates parent dir)', async () => {
    const nested = path.join(tmpDir, 'nested', 'dir', 'settings.json')

    const result = await attach({ port: 8787, version: '1.0.0', settingsPath: nested })

    expect(result).toEqual({ changed: true })
    const written = JSON.parse(fs.readFileSync(nested, 'utf8'))
    expect(written.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8787')
    expect(written._collectivus).toMatchObject({ version: '1.0.0', port: 8787 })
    expect(typeof written._collectivus.attached_at).toBe('string')
    expect(new Date(written._collectivus.attached_at).toISOString()).toBe(
      written._collectivus.attached_at
    )
  })

  it('handles an empty {} file', async () => {
    writeJson({})

    const result = await attach({ port: 8787, version: '1.2.3', settingsPath })

    expect(result).toEqual({ changed: true })
    const written = readJson()
    expect(written.env).toEqual({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787' })
    expect(written._collectivus).toMatchObject({ version: '1.2.3', port: 8787 })
  })

  it('preserves unrelated keys at the top level and inside env', async () => {
    writeJson({
      includeCoAuthoredBy: false,
      env: { OTHER_KEY: 'keep-me' },
      hooks: { stop: 'echo hi' },
    })

    await attach({ port: 9000, version: '2.0.0', settingsPath })

    const written = readJson()
    expect(written.includeCoAuthoredBy).toBe(false)
    expect(written.hooks).toEqual({ stop: 'echo hi' })
    expect(written.env).toEqual({
      OTHER_KEY: 'keep-me',
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9000',
    })
  })

  it('returns the previous ANTHROPIC_BASE_URL when one was set', async () => {
    writeJson({ env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com', OTHER: 'x' } })

    const result = await attach({ port: 8787, version: '1.0.0', settingsPath })

    expect(result).toEqual({
      changed: true,
      prevValue: 'https://api.anthropic.com',
    })
    const written = readJson()
    expect(written.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8787')
    expect(written.env.OTHER).toBe('x')
  })

  it('omits prevValue when no previous ANTHROPIC_BASE_URL was set', async () => {
    writeJson({ env: { OTHER_KEY: 'keep-me' } })

    const result = await attach({ port: 8787, version: '1.0.0', settingsPath })

    expect(result).toEqual({ changed: true })
    expect('prevValue' in result).toBe(false)
  })

  it('treats a same-port previous value as prevValue (still overwrites with fresh marker)', async () => {
    writeJson({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787' } })

    const result = await attach({ port: 8787, version: '1.0.0', settingsPath })

    expect(result).toEqual({
      changed: true,
      prevValue: 'http://127.0.0.1:8787',
    })
  })

  it('rejects malformed JSON without modifying the file', async () => {
    fs.writeFileSync(settingsPath, '{ not valid json ')
    const before = fs.readFileSync(settingsPath, 'utf8')

    await expect(
      attach({ port: 8787, version: '1.0.0', settingsPath })
    ).rejects.toBeInstanceOf(SettingsError)

    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before)
  })

  it('rejects JSONC files with a clear error', async () => {
    fs.writeFileSync(
      settingsPath,
      '// a comment\n{ "env": { "ANTHROPIC_BASE_URL": "x" } }\n'
    )

    /** @type {unknown} */
    let caught
    try {
      await attach({ port: 8787, version: '1.0.0', settingsPath })
    } catch (err) {
      caught = err
    }
    if (!(caught instanceof SettingsError)) {
      throw new Error(`expected SettingsError, got: ${String(caught)}`)
    }
    expect(caught.code).toBe('JSONC')
    expect(caught.message).toMatch(/JSONC/)
  })

  it('rejects a non-object root', async () => {
    fs.writeFileSync(settingsPath, '[]')

    await expect(
      attach({ port: 8787, version: '1.0.0', settingsPath })
    ).rejects.toThrow(/must contain a JSON object at the root/)
  })

  it('rejects an env that is not an object by replacing it', async () => {
    // env is a number; ensurePlainObject overwrites it.
    writeJson({ env: 42 })

    const result = await attach({ port: 8787, version: '1.0.0', settingsPath })

    expect(result).toEqual({ changed: true })
    const written = readJson()
    expect(written.env).toEqual({ ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787' })
  })

  it('rejects an invalid port', async () => {
    writeJson({})
    await expect(
      attach({ port: -1, version: '1.0.0', settingsPath })
    ).rejects.toThrow(/invalid port/)
    await expect(
      attach({ port: 70000, version: '1.0.0', settingsPath })
    ).rejects.toThrow(/invalid port/)
    await expect(
      // @ts-expect-error testing runtime guard
      attach({ port: '8787', version: '1.0.0', settingsPath })
    ).rejects.toThrow(/invalid port/)
  })

  it('rejects an empty version string', async () => {
    writeJson({})
    await expect(
      attach({ port: 8787, version: '', settingsPath })
    ).rejects.toThrow(/version must be a non-empty string/)
  })
})

describe('detach', () => {
  it('is a no-op when the file is missing', async () => {
    const result = await detach({ settingsPath })
    expect(result).toEqual({ changed: false })
    expect(fs.existsSync(settingsPath)).toBe(false)
  })

  it('is a no-op when there is no _collectivus marker', async () => {
    writeJson({ env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' } })
    const before = fs.readFileSync(settingsPath, 'utf8')

    const result = await detach({ settingsPath })

    expect(result).toEqual({ changed: false })
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before)
  })

  it('removes the marker and matching env entry, returns the removed URL', async () => {
    writeJson({
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787', OTHER: 'keep' },
      _collectivus: { attached_at: '2026-01-01T00:00:00Z', version: '1.0.0', port: 8787 },
      includeCoAuthoredBy: false,
    })

    const result = await detach({ settingsPath })

    expect(result).toEqual({ changed: true, removed: 'http://127.0.0.1:8787' })
    expect(readJson()).toEqual({
      env: { OTHER: 'keep' },
      includeCoAuthoredBy: false,
    })
  })

  it('removes the env key entirely if it becomes empty', async () => {
    writeJson({
      env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787' },
      _collectivus: { attached_at: '2026-01-01T00:00:00Z', version: '1.0.0', port: 8787 },
    })

    await detach({ settingsPath })

    const written = readJson()
    expect('env' in written).toBe(false)
    expect('_collectivus' in written).toBe(false)
  })

  it('warns and leaves env alone when ANTHROPIC_BASE_URL was overridden externally', async () => {
    writeJson({
      env: { ANTHROPIC_BASE_URL: 'https://elsewhere.example' },
      _collectivus: { attached_at: '2026-01-01T00:00:00Z', version: '1.0.0', port: 8787 },
    })

    const result = await detach({ settingsPath })

    expect(result.changed).toBe(true)
    expect(result.warning).toMatch(/overridden externally/)
    expect('removed' in result).toBe(false)

    const written = readJson()
    expect(written.env).toEqual({ ANTHROPIC_BASE_URL: 'https://elsewhere.example' })
    expect('_collectivus' in written).toBe(false)
  })

  it('removes only the marker when env has no ANTHROPIC_BASE_URL', async () => {
    writeJson({
      env: { OTHER: 'x' },
      _collectivus: { attached_at: '2026-01-01T00:00:00Z', version: '1.0.0', port: 8787 },
    })

    const result = await detach({ settingsPath })

    expect(result).toEqual({ changed: true })
    expect(readJson()).toEqual({ env: { OTHER: 'x' } })
  })

  it('rejects malformed JSON without modifying the file', async () => {
    fs.writeFileSync(settingsPath, '{ not valid json ')
    const before = fs.readFileSync(settingsPath, 'utf8')

    await expect(detach({ settingsPath })).rejects.toBeInstanceOf(SettingsError)

    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before)
  })
})

describe('isAttached', () => {
  it('returns false when the file is missing', async () => {
    expect(await isAttached({ settingsPath })).toBe(false)
  })

  it('returns false when there is no marker', async () => {
    writeJson({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:8787' } })
    expect(await isAttached({ settingsPath })).toBe(false)
  })

  it('returns true when the marker is present', async () => {
    writeJson({
      _collectivus: { attached_at: '2026-01-01T00:00:00Z', version: '1.0.0', port: 8787 },
    })
    expect(await isAttached({ settingsPath })).toBe(true)
  })

  it('throws on malformed JSON', async () => {
    fs.writeFileSync(settingsPath, 'not json')
    await expect(isAttached({ settingsPath })).rejects.toBeInstanceOf(SettingsError)
  })
})

describe('round-trip', () => {
  it('attach + detach restores original content exactly (whitespace normalized to JSON.stringify(value, null, 2) + newline)', async () => {
    /** @type {Record<string, unknown>} */
    const original = {
      env: { OTHER: 'keep' },
      includeCoAuthoredBy: false,
      hooks: { stop: 'echo done' },
      arr: [1, 2, 3],
    }
    writeJson(original)
    const expectedRoundtrip = JSON.stringify(original, null, 2) + '\n'

    await attach({ port: 8787, version: '1.0.0', settingsPath })
    await detach({ settingsPath })

    const after = fs.readFileSync(settingsPath, 'utf8')
    expect(after).toBe(expectedRoundtrip)
  })

  it('attach + detach on an originally-empty {} produces {} (then newline)', async () => {
    writeJson({})

    await attach({ port: 8787, version: '1.0.0', settingsPath })
    await detach({ settingsPath })

    expect(fs.readFileSync(settingsPath, 'utf8')).toBe('{}\n')
  })
})

describe('atomic write', () => {
  it('does not leave a partial file when the write succeeds (sanity)', async () => {
    writeJson({ env: { OTHER: 'x' } })

    await attach({ port: 8787, version: '1.0.0', settingsPath })

    const entries = fs.readdirSync(tmpDir)
    // Only the final file should remain; no .tmp leftovers.
    expect(entries).toEqual(['settings.json'])
  })

  it('a tmp file present from a previous crash is not picked up as the final file', async () => {
    // Simulate a crash mid-write: a stale .tmp sibling exists, but the
    // real settings.json is still the previous good content.
    writeJson({ env: { GOOD: 'previous' } })
    const stale = path.join(tmpDir, 'settings.json.99999.deadbeef.tmp')
    fs.writeFileSync(stale, '{"corrupt": true')

    // attach should overwrite settings.json atomically and ignore the stale tmp.
    await attach({ port: 8787, version: '1.0.0', settingsPath })

    const written = readJson()
    expect(written.env.GOOD).toBe('previous')
    expect(written.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8787')
    // Stale tmp from prior crash is left for the user/admin to clean up.
    expect(fs.existsSync(stale)).toBe(true)
  })

  it('the file is either fully old or fully new (rename is atomic)', async () => {
    // We can't truly observe a half-rename in userspace on POSIX (rename(2)
    // is atomic), but we can verify the post-condition: at no observable
    // moment is the file content malformed JSON. After attach, parsing
    // succeeds and yields the new content.
    writeJson({ env: { OTHER: 'x' } })

    await attach({ port: 8787, version: '1.0.0', settingsPath })

    // Parsing must succeed -- proves the write was not partial.
    const parsed = readJson()
    expect(parsed._collectivus).toBeDefined()
    expect(parsed.env.OTHER).toBe('x')
    expect(parsed.env.ANTHROPIC_BASE_URL).toBe('http://127.0.0.1:8787')
  })

  it('does not leave a tmp file when rename fails', async () => {
    // Force a rename failure by pointing at a directory path as the final
    // target. Pre-create a directory at settingsPath so rename(tmp -> dir)
    // fails on every reasonable platform.
    fs.rmSync(settingsPath, { force: true })
    fs.mkdirSync(settingsPath)

    /** @type {unknown} */
    let caught
    try {
      await attach({ port: 8787, version: '1.0.0', settingsPath })
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(Error)

    // Check no .tmp files survived.
    const tmpEntries = fs.readdirSync(tmpDir).filter((n) => n.endsWith('.tmp'))
    expect(tmpEntries).toEqual([])

    // Cleanup the placeholder directory we created.
    fs.rmdirSync(settingsPath)
  })

  it('creates a new file with mode 0600 (skipped on Windows)', async () => {
    if (process.platform === 'win32') return

    // settings.json does not exist; attach should create it with 0600.
    await attach({ port: 8787, version: '1.0.0', settingsPath })
    const stat = await fsp.stat(settingsPath)
    expect(stat.mode & 0o777).toBe(0o600)
  })

  it('preserves existing file mode on overwrite (skipped on Windows)', async () => {
    if (process.platform === 'win32') return

    writeJson({})
    fs.chmodSync(settingsPath, 0o644)

    await attach({ port: 8787, version: '1.0.0', settingsPath })

    const stat = await fsp.stat(settingsPath)
    expect(stat.mode & 0o777).toBe(0o644)
  })
})
