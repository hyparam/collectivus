import process from 'node:process'
import { ConfigError, loadConfig as defaultLoadConfig } from '../config.js'
import { attach as defaultAttach, defaultSettingsPath } from '../claude-code/settings.js'
import { parseListenPort, readPackageVersion } from './common.js'

/**
 * @import { AttachParseResult, AttachHooks, CollectivusConfig } from '../types.js'
 */

const USAGE = `Usage:
  collectivus attach (--config <path> | --port <n>)

Options:
  --config <path>   Read the proxy port from this collectivus config
  --port <n>        Use this port directly
  --help, -h        Show this help

Edits ~/.claude/settings.json to point Claude Code at the local proxy.
Exactly one of --config or --port is required.`

/**
 * Parse the argument list of `collectivus attach`.
 *
 * @param {string[]} argv
 * @returns {AttachParseResult}
 */
export function parseAttachArgs(argv) {
  /** @type {string | undefined} */
  let configPath
  /** @type {number | undefined} */
  let port
  /**
   * @param {boolean} help
   * @param {string} [error]
   * @returns {AttachParseResult}
   */
  const result = (help, error) => {
    /** @type {AttachParseResult} */
    const r = { help }
    if (configPath !== undefined) r.configPath = configPath
    if (port !== undefined) r.port = port
    if (error !== undefined) r.error = error
    return r
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return result(true)
    if (arg === '--config' || arg.startsWith('--config=')) {
      const value = arg === '--config' ? argv[++i] : arg.slice('--config='.length)
      if (!value) return result(false, '--config requires a path')
      configPath = value
      continue
    }
    if (arg === '--port' || arg.startsWith('--port=')) {
      const value = arg === '--port' ? argv[++i] : arg.slice('--port='.length)
      if (!value) return result(false, '--port requires a number')
      if (!/^\d+$/.test(value)) return result(false, `--port: not a valid port (got "${value}")`)
      const n = Number.parseInt(value, 10)
      if (n < 1 || n > 65535) return result(false, `--port: not a valid port (got "${value}")`)
      port = n
      continue
    }
    return result(false, `unknown argument: ${arg}`)
  }
  if (configPath !== undefined && port !== undefined) {
    return result(false, '--config and --port are mutually exclusive')
  }
  if (configPath === undefined && port === undefined) {
    return result(false, 'one of --config or --port is required')
  }
  return result(false)
}

/**
 * Run `collectivus attach`.
 *
 * Resolves the proxy port from `--port` or `proxy.listen` in the supplied
 * config, then writes the marker + `env.ANTHROPIC_BASE_URL` to settings.json.
 *
 * @param {string[]} argv
 * @param {AttachHooks} [hooks]
 * @returns {Promise<number>}
 */
export async function runAttach(argv, hooks = {}) {
  const stdout = hooks.stdout ?? process.stdout
  const stderr = hooks.stderr ?? process.stderr
  const attachFn = hooks.attach ?? defaultAttach
  const loadConfigFn = hooks.loadConfig ?? defaultLoadConfig
  const settingsPath = hooks.settingsPath ?? defaultSettingsPath()

  const parsed = parseAttachArgs(argv)
  if (parsed.help) {
    stdout.write(USAGE + '\n')
    return 0
  }
  if (parsed.error) {
    stderr.write(`error: ${parsed.error}\n\n${USAGE}\n`)
    return 2
  }

  /** @type {number} */
  let port
  if (parsed.port !== undefined) {
    port = parsed.port
  } else if (parsed.configPath !== undefined) {
    /** @type {CollectivusConfig} */
    let config
    try {
      config = loadConfigFn(parsed.configPath)
    } catch (err) {
      if (err instanceof ConfigError) {
        stderr.write(`config error: ${err.message}\n`)
        return 1
      }
      throw err
    }
    if (!config.proxy) {
      stderr.write('error: config must define `proxy.listen` to derive the attach port\n')
      return 1
    }
    try {
      port = parseListenPort(config.proxy.listen)
    } catch (err) {
      stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
      return 1
    }
  } else {
    // Defensive: parser should have caught this.
    stderr.write('error: one of --config or --port is required\n')
    return 2
  }

  const version = hooks.version ?? readPackageVersion()

  /** @type {{ changed: boolean, prevValue?: string }} */
  let result
  try {
    result = await attachFn({ port, version, settingsPath })
  } catch (err) {
    stderr.write(`error: failed to attach Claude Code: ${err instanceof Error ? err.message : String(err)}\n`)
    return 1
  }

  stdout.write(`✓ Claude Code attached (${settingsPath})\n`)
  stdout.write(`  ANTHROPIC_BASE_URL = http://127.0.0.1:${port}\n`)
  if (result.prevValue !== undefined) {
    stdout.write(`  (previous ANTHROPIC_BASE_URL was ${result.prevValue})\n`)
  }
  return 0
}
