import process from 'node:process'
import { ConfigError, loadConfig as defaultLoadConfig } from '../config.js'
import { attach as defaultAttachClaude, defaultSettingsPath } from '../claude-code/settings.js'
import { attach as defaultAttachCodex, defaultConfigPath as defaultCodexConfigPath } from '../codex/settings.js'
import { parseListenPort, readPackageVersion } from './common.js'

/**
 * @import { AttachParseResult, AttachHooks, CollectivusConfig } from '../types.js'
 */

const USAGE = `Usage:
  collectivus attach (--config <path> | --port <n>) [--client claude|codex|all]

Options:
  --config <path>   Read the proxy port from this collectivus config
  --port <n>        Use this port directly
  --client <name>   Tool to configure: claude, codex, or all (default: claude)
  --help, -h        Show this help

Edits Claude Code and/or Codex configuration to point at the local proxy.
Exactly one of --config or --port is required.`

/**
 * Parse the argument list of `collectivus attach`.
 *
 * @param {string[]} argv
 * @returns {AttachParseResult}
 */
export function parseAttachArgs(argv) {
  /** @type {AttachParseResult} */
  const r = { help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      r.help = true
      return r
    }
    if (arg === '--config' || arg.startsWith('--config=')) {
      const value = arg === '--config' ? argv[++i] : arg.slice('--config='.length)
      if (!value) { r.error = '--config requires a path'; return r }
      r.configPath = value
      continue
    }
    if (arg === '--port' || arg.startsWith('--port=')) {
      const value = arg === '--port' ? argv[++i] : arg.slice('--port='.length)
      if (!value) { r.error = '--port requires a number'; return r }
      if (!/^\d+$/.test(value)) { r.error = `--port: not a valid port (got "${value}")`; return r }
      const n = Number.parseInt(value, 10)
      if (n < 1 || n > 65535) { r.error = `--port: not a valid port (got "${value}")`; return r }
      r.port = n
      continue
    }
    if (arg === '--client' || arg.startsWith('--client=')) {
      const value = arg === '--client' ? argv[++i] : arg.slice('--client='.length)
      if (!value) { r.error = '--client requires claude, codex, or all'; return r }
      if (value !== 'claude' && value !== 'codex' && value !== 'all') {
        r.error = `--client: expected claude, codex, or all (got "${value}")`
        return r
      }
      r.client = value
      continue
    }
    r.error = `unknown argument: ${arg}`
    return r
  }
  if (r.configPath !== undefined && r.port !== undefined) {
    r.error = '--config and --port are mutually exclusive'
  } else if (r.configPath === undefined && r.port === undefined) {
    r.error = 'one of --config or --port is required'
  }
  if (r.client === undefined) r.client = 'claude'
  return r
}

/**
 * Run `collectivus attach`.
 *
 * Resolves the proxy port from `--port` or `proxy.listen` in the supplied
 * config, then updates the selected client configuration.
 *
 * @param {string[]} argv
 * @param {AttachHooks} [hooks]
 * @returns {Promise<number>}
 */
export async function runAttach(argv, hooks = {}) {
  const stdout = hooks.stdout ?? process.stdout
  const stderr = hooks.stderr ?? process.stderr
  const attachClaude = hooks.attachClaude ?? hooks.attach ?? defaultAttachClaude
  const attachCodex = hooks.attachCodex ?? defaultAttachCodex
  const loadConfigFn = hooks.loadConfig ?? defaultLoadConfig
  const settingsPath = hooks.settingsPath ?? defaultSettingsPath()
  const codexConfigPath = hooks.codexConfigPath ?? defaultCodexConfigPath()

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
  /** @type {CollectivusConfig | undefined} */
  let config
  if (parsed.port !== undefined) {
    port = parsed.port
  } else if (parsed.configPath !== undefined) {
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

  if ((parsed.client === 'codex' || parsed.client === 'all') && config && !hasProxyRoute(config, '/v1/responses')) {
    stderr.write(
      'error: Codex attach requires a proxy upstream that routes /v1/responses ' +
      '(for OpenAI, use match.path_prefix "/v1" with base_url "https://api.openai.com")\n'
    )
    return 1
  }

  const version = hooks.version ?? readPackageVersion()

  if (parsed.client === 'claude' || parsed.client === 'all') {
    /** @type {{ changed: boolean, prevValue?: string }} */
    let result
    try {
      result = await attachClaude({ port, version, settingsPath })
    } catch (err) {
      stderr.write(`error: failed to attach Claude Code: ${err instanceof Error ? err.message : String(err)}\n`)
      return 1
    }

    stdout.write(`✓ Claude Code attached (${settingsPath})\n`)
    stdout.write(`  ANTHROPIC_BASE_URL = http://127.0.0.1:${port}\n`)
    if (result.prevValue !== undefined) {
      stdout.write(`  (previous ANTHROPIC_BASE_URL was ${result.prevValue})\n`)
    }
  }

  if (parsed.client === 'codex' || parsed.client === 'all') {
    /** @type {{ changed: boolean, prevValue?: string }} */
    let result
    try {
      result = await attachCodex({ port, version, configPath: codexConfigPath })
    } catch (err) {
      stderr.write(`error: failed to attach Codex: ${err instanceof Error ? err.message : String(err)}\n`)
      return 1
    }

    stdout.write(`✓ Codex attached (${codexConfigPath})\n`)
    stdout.write('  model_provider = collectivus\n')
    stdout.write(`  base_url = http://127.0.0.1:${port}/v1\n`)
    if (result.prevValue !== undefined) {
      stdout.write(`  (previous model_provider was ${result.prevValue})\n`)
    }
  }

  return 0
}

/**
 * @param {CollectivusConfig} config
 * @param {string} requestPath
 * @returns {boolean}
 */
function hasProxyRoute(config, requestPath) {
  return (config.proxy?.upstreams ?? []).some(function(upstream) {
    const prefix = upstream?.match?.path_prefix
    return typeof prefix === 'string' && prefix.length > 0 && requestPath.startsWith(prefix)
  })
}
