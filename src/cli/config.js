import fs from 'node:fs'
import process from 'node:process'
import { ConfigError, loadConfig as defaultLoadConfig, validateCollectivusConfig } from '../config.js'
import { GATEWAY_ID_MAX_LENGTH, GATEWAY_ID_PATTERN } from '../gateway_id.js'
import { createConfigRegistry, deleteConfig, getConfig, listGateways, resolveConfigsDir, setConfig } from '../server/config_registry.js'
import { BootstrapStore } from '../server/identity.js'
import { defaultPrompt } from './common.js'

/**
 * @import { CollectivusConfig, ServerConfig } from '../types.js'
 * @import { ConfigCliHooks, ParsedConfigArgs, ParsedDelete, ParsedError, ParsedGet, ParsedHelp, ParsedList, ParsedSet, ParsedTokenIssue, ParsedTokenRevoke } from './types.d.ts'
 * @import { ConfigRegistry } from '../server/types.d.ts'
 */

const USAGE = `Usage:
  ctvs config set <gateway-id> --server-config <path> --file <config.json>
  ctvs config get <gateway-id> --server-config <path>
  ctvs config list --server-config <path>
  ctvs config delete <gateway-id> --server-config <path> [--yes]
  ctvs config bootstrap-token issue <gateway-id> --server-config <path> [--ttl-seconds <n>]
  ctvs config bootstrap-token revoke <gateway-id> --server-config <path>

Options:
  --server-config <path>   Path to the server's collectivus.json config (required)
  --file <path>            For \`set\`: path to the JSON config to register
  --yes, -y                For \`delete\`: skip the interactive confirmation
  --ttl-seconds <n>        For \`bootstrap-token issue\`: TTL override in seconds
  --help, -h               Show this help`

/**
 * Parse the argument list of `collectivus config <subcommand>`.
 *
 * @param {string[]} argv
 * @returns {ParsedConfigArgs}
 */
export function parseConfigArgs(argv) {
  if (argv.length === 0) {
    return { kind: 'error', message: 'subcommand is required', exitCode: 2 }
  }
  const [first, ...rest] = argv
  if (first === '--help' || first === '-h') return { kind: 'help' }
  switch (first) {
  case 'set': return parseSet(rest)
  case 'get': return parseGet(rest)
  case 'list': return parseList(rest)
  case 'delete': return parseDelete(rest)
  case 'bootstrap-token': return parseBootstrapToken(rest)
  default:
    return { kind: 'error', message: `unknown subcommand: ${first}`, exitCode: 2 }
  }
}

/**
 * @param {string[]} argv
 * @returns {ParsedSet | ParsedHelp | ParsedError}
 */
function parseSet(argv) {
  /** @type {string | undefined} */ let gatewayId
  /** @type {string | undefined} */ let serverConfig
  /** @type {string | undefined} */ let file
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { kind: 'help' }
    if (arg === '--server-config' || arg.startsWith('--server-config=')) {
      const value = arg === '--server-config' ? argv[++i] : arg.slice('--server-config='.length)
      if (!value) return parseError('--server-config requires a path')
      serverConfig = value
      continue
    }
    if (arg === '--file' || arg.startsWith('--file=')) {
      const value = arg === '--file' ? argv[++i] : arg.slice('--file='.length)
      if (!value) return parseError('--file requires a path')
      file = value
      continue
    }
    if (arg.startsWith('-')) return parseError(`unknown argument: ${arg}`)
    if (gatewayId !== undefined) return parseError(`unexpected positional argument: ${arg}`)
    gatewayId = arg
  }
  if (!gatewayId) return parseError('gateway-id is required')
  const validId = validateGatewayId(gatewayId)
  if (validId) return validId
  if (!serverConfig) return parseError('--server-config is required')
  if (!file) return parseError('--file is required')
  return { kind: 'set', gatewayId, serverConfig, file }
}

/**
 * @param {string[]} argv
 * @returns {ParsedGet | ParsedHelp | ParsedError}
 */
function parseGet(argv) {
  /** @type {string | undefined} */ let gatewayId
  /** @type {string | undefined} */ let serverConfig
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { kind: 'help' }
    if (arg === '--server-config' || arg.startsWith('--server-config=')) {
      const value = arg === '--server-config' ? argv[++i] : arg.slice('--server-config='.length)
      if (!value) return parseError('--server-config requires a path')
      serverConfig = value
      continue
    }
    if (arg.startsWith('-')) return parseError(`unknown argument: ${arg}`)
    if (gatewayId !== undefined) return parseError(`unexpected positional argument: ${arg}`)
    gatewayId = arg
  }
  if (!gatewayId) return parseError('gateway-id is required')
  const validId = validateGatewayId(gatewayId)
  if (validId) return validId
  if (!serverConfig) return parseError('--server-config is required')
  return { kind: 'get', gatewayId, serverConfig }
}

/**
 * @param {string[]} argv
 * @returns {ParsedList | ParsedHelp | ParsedError}
 */
function parseList(argv) {
  /** @type {string | undefined} */ let serverConfig
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { kind: 'help' }
    if (arg === '--server-config' || arg.startsWith('--server-config=')) {
      const value = arg === '--server-config' ? argv[++i] : arg.slice('--server-config='.length)
      if (!value) return parseError('--server-config requires a path')
      serverConfig = value
      continue
    }
    return parseError(`unknown argument: ${arg}`)
  }
  if (!serverConfig) return parseError('--server-config is required')
  return { kind: 'list', serverConfig }
}

/**
 * @param {string[]} argv
 * @returns {ParsedDelete | ParsedHelp | ParsedError}
 */
function parseDelete(argv) {
  /** @type {string | undefined} */ let gatewayId
  /** @type {string | undefined} */ let serverConfig
  let yes = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { kind: 'help' }
    if (arg === '--server-config' || arg.startsWith('--server-config=')) {
      const value = arg === '--server-config' ? argv[++i] : arg.slice('--server-config='.length)
      if (!value) return parseError('--server-config requires a path')
      serverConfig = value
      continue
    }
    if (arg === '--yes' || arg === '-y') { yes = true; continue }
    if (arg.startsWith('-')) return parseError(`unknown argument: ${arg}`)
    if (gatewayId !== undefined) return parseError(`unexpected positional argument: ${arg}`)
    gatewayId = arg
  }
  if (!gatewayId) return parseError('gateway-id is required')
  const validId = validateGatewayId(gatewayId)
  if (validId) return validId
  if (!serverConfig) return parseError('--server-config is required')
  return { kind: 'delete', gatewayId, serverConfig, yes }
}

/**
 * @param {string[]} argv
 * @returns {ParsedTokenIssue | ParsedTokenRevoke | ParsedHelp | ParsedError}
 */
function parseBootstrapToken(argv) {
  if (argv.length === 0) return parseError('bootstrap-token requires "issue" or "revoke"')
  const [action, ...rest] = argv
  if (action === '--help' || action === '-h') return { kind: 'help' }
  if (action === 'issue') return parseTokenIssue(rest)
  if (action === 'revoke') return parseTokenRevoke(rest)
  return parseError(`unknown bootstrap-token action: ${action}`)
}

/**
 * @param {string[]} argv
 * @returns {ParsedTokenIssue | ParsedHelp | ParsedError}
 */
function parseTokenIssue(argv) {
  /** @type {string | undefined} */ let gatewayId
  /** @type {string | undefined} */ let serverConfig
  /** @type {number | undefined} */ let ttlSeconds
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { kind: 'help' }
    if (arg === '--server-config' || arg.startsWith('--server-config=')) {
      const value = arg === '--server-config' ? argv[++i] : arg.slice('--server-config='.length)
      if (!value) return parseError('--server-config requires a path')
      serverConfig = value
      continue
    }
    if (arg === '--ttl-seconds' || arg.startsWith('--ttl-seconds=')) {
      const value = arg === '--ttl-seconds' ? argv[++i] : arg.slice('--ttl-seconds='.length)
      if (!value) return parseError('--ttl-seconds requires a value')
      const n = Number.parseInt(value, 10)
      if (!Number.isInteger(n) || n <= 0 || String(n) !== value.trim()) {
        return parseError('--ttl-seconds must be a positive integer')
      }
      ttlSeconds = n
      continue
    }
    if (arg.startsWith('-')) return parseError(`unknown argument: ${arg}`)
    if (gatewayId !== undefined) return parseError(`unexpected positional argument: ${arg}`)
    gatewayId = arg
  }
  if (!gatewayId) return parseError('gateway-id is required')
  const validId = validateGatewayId(gatewayId)
  if (validId) return validId
  if (!serverConfig) return parseError('--server-config is required')
  /** @type {ParsedTokenIssue} */
  const result = { kind: 'token-issue', gatewayId, serverConfig }
  if (ttlSeconds !== undefined) result.ttlSeconds = ttlSeconds
  return result
}

/**
 * @param {string[]} argv
 * @returns {ParsedTokenRevoke | ParsedHelp | ParsedError}
 */
function parseTokenRevoke(argv) {
  /** @type {string | undefined} */ let gatewayId
  /** @type {string | undefined} */ let serverConfig
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { kind: 'help' }
    if (arg === '--server-config' || arg.startsWith('--server-config=')) {
      const value = arg === '--server-config' ? argv[++i] : arg.slice('--server-config='.length)
      if (!value) return parseError('--server-config requires a path')
      serverConfig = value
      continue
    }
    if (arg.startsWith('-')) return parseError(`unknown argument: ${arg}`)
    if (gatewayId !== undefined) return parseError(`unexpected positional argument: ${arg}`)
    gatewayId = arg
  }
  if (!gatewayId) return parseError('gateway-id is required')
  const validId = validateGatewayId(gatewayId)
  if (validId) return validId
  if (!serverConfig) return parseError('--server-config is required')
  return { kind: 'token-revoke', gatewayId, serverConfig }
}

/**
 * @param {string} message
 * @returns {ParsedError}
 */
function parseError(message) {
  return { kind: 'error', message, exitCode: 2 }
}

/**
 * Mirrors the registry's gateway-id rules so a malformed id is rejected at
 * parse time with a friendly message rather than bubbling up from the registry
 * as a generic "invalid gatewayId" error.
 *
 * @param {string} id
 * @returns {ParsedError | undefined}
 */
function validateGatewayId(id) {
  if (id.length > GATEWAY_ID_MAX_LENGTH || !GATEWAY_ID_PATTERN.test(id) || id === '.' || id === '..') {
    return parseError(
      `invalid gateway-id ${JSON.stringify(id)}: must start with [A-Za-z0-9] and contain only [A-Za-z0-9._+@-] (max ${GATEWAY_ID_MAX_LENGTH} chars); cannot be "." or ".."`
    )
  }
  return undefined
}

/**
 * Run `collectivus config <subcommand>`.
 *
 * Operator-mode CLI for managing per-gateway configs and bootstrap tokens.
 * Every subcommand needs `--server-config` so we can locate `data_dir` (config
 * registry) and `identity_issuer.bootstrap_store_path` (bootstrap store) — the
 * CLI must read the same on-disk state the running server uses.
 *
 * @param {string[]} argv
 * @param {ConfigCliHooks} [hooks]
 * @returns {Promise<number>}
 */
export async function runConfig(argv, hooks = {}) {
  const stdout = hooks.stdout ?? process.stdout
  const stderr = hooks.stderr ?? process.stderr
  const isTTY = hooks.isTTY ?? Boolean(process.stdin.isTTY)
  const promptFn = hooks.prompt ?? defaultPrompt
  const loadConfigFn = hooks.loadConfig ?? defaultLoadConfig
  const readFileFn = hooks.readFile ?? ((/** @type {string} */ p) => fs.readFileSync(p, 'utf8'))
  const makeRegistry = hooks.makeRegistry ?? ((/** @type {ServerConfig} */ s) => createConfigRegistry({ configsDir: resolveConfigsDir(s) }))
  const makeBootstrapStore = hooks.makeBootstrapStore ?? ((/** @type {string} */ p) => new BootstrapStore({ path: p }))

  const parsed = parseConfigArgs(argv)
  if (parsed.kind === 'help') {
    stdout.write(USAGE + '\n')
    return 0
  }
  if (parsed.kind === 'error') {
    stderr.write(`error: ${parsed.message}\n\n${USAGE}\n`)
    return parsed.exitCode
  }

  /** @type {CollectivusConfig} */
  let serverConfig
  try {
    serverConfig = loadConfigFn(parsed.serverConfig)
  } catch (err) {
    if (err instanceof ConfigError) {
      stderr.write(`error: server config: ${err.message}\n`)
      return 1
    }
    throw err
  }

  if (serverConfig.role !== 'server' || !serverConfig.server) {
    stderr.write('error: --server-config must point at a config with role: "server" (the operator CLI runs on the server host)\n')
    return 1
  }
  const server = serverConfig.server

  switch (parsed.kind) {
  case 'set': return runSet(parsed, server, { stdout, stderr, readFile: readFileFn, makeRegistry })
  case 'get': return runGet(parsed, server, { stdout, stderr, makeRegistry })
  case 'list': return runList(parsed, server, { stdout, makeRegistry })
  case 'delete': return runDelete(parsed, server, { stdout, stderr, isTTY, prompt: promptFn, makeRegistry })
  case 'token-issue': return runTokenIssue(parsed, server, { stdout, stderr, makeBootstrapStore })
  case 'token-revoke': return runTokenRevoke(parsed, server, { stdout, makeBootstrapStore })
  default: {
    /** @type {never} */ const exhaustive = parsed
    void exhaustive
    return 1
  }
  }
}

/**
 * @param {ParsedSet} parsed
 * @param {ServerConfig} server
 * @param {{
 *   stdout: { write: (s: string) => void },
 *   stderr: { write: (s: string) => void },
 *   readFile: (p: string) => string,
 *   makeRegistry: (s: ServerConfig) => ConfigRegistry,
 * }} ctx
 * @returns {number}
 */
function runSet(parsed, server, ctx) {
  /** @type {string} */
  let raw
  try {
    raw = ctx.readFile(parsed.file)
  } catch (err) {
    const code = err && typeof err === 'object' && 'code' in err ? err.code : undefined
    if (code === 'ENOENT') {
      ctx.stderr.write(`error: file not found: ${parsed.file}\n`)
      return 1
    }
    ctx.stderr.write(`error: failed to read ${parsed.file}: ${formatError(err)}\n`)
    return 1
  }

  /** @type {unknown} */
  let parsedConfig
  try {
    parsedConfig = JSON.parse(raw)
  } catch (err) {
    ctx.stderr.write(`error: invalid JSON in ${parsed.file}: ${formatError(err)}\n`)
    return 1
  }

  // Validate up-front with the operator's stderr so unknown top-level keys
  // produce a visible warning here (the registry's own validation is silent).
  try {
    validateCollectivusConfig(parsedConfig, { stderr: ctx.stderr })
  } catch (err) {
    if (err instanceof ConfigError) {
      ctx.stderr.write(`error: invalid config: ${err.message}\n`)
      return 1
    }
    throw err
  }

  /** @type {ConfigRegistry} */
  const registry = ctx.makeRegistry(server)
  /** @type {{ etag: string }} */
  let result
  try {
    result = setConfig(registry, parsed.gatewayId, parsedConfig)
  } catch (err) {
    ctx.stderr.write(`error: failed to write config: ${formatError(err)}\n`)
    return 1
  }
  ctx.stdout.write(`✓ Wrote config for ${parsed.gatewayId} (etag ${result.etag})\n`)
  return 0
}

/**
 * @param {ParsedGet} parsed
 * @param {ServerConfig} server
 * @param {{
 *   stdout: { write: (s: string) => void },
 *   stderr: { write: (s: string) => void },
 *   makeRegistry: (s: ServerConfig) => ConfigRegistry,
 * }} ctx
 * @returns {number}
 */
function runGet(parsed, server, ctx) {
  const registry = ctx.makeRegistry(server)
  /** @type {ReturnType<typeof getConfig>} */
  let entry
  try {
    entry = getConfig(registry, parsed.gatewayId)
  } catch (err) {
    ctx.stderr.write(`error: ${formatError(err)}\n`)
    return 1
  }
  if (!entry) {
    ctx.stderr.write(`error: no config found for ${parsed.gatewayId}\n`)
    return 1
  }
  ctx.stdout.write(JSON.stringify(entry.config, null, 2) + '\n')
  return 0
}

/**
 * @param {ParsedList} parsed
 * @param {ServerConfig} server
 * @param {{
 *   stdout: { write: (s: string) => void },
 *   makeRegistry: (s: ServerConfig) => ConfigRegistry,
 * }} ctx
 * @returns {number}
 */
function runList(parsed, server, ctx) {
  void parsed
  const registry = ctx.makeRegistry(server)
  const ids = listGateways(registry)
  for (const id of ids) ctx.stdout.write(id + '\n')
  return 0
}

/**
 * @param {ParsedDelete} parsed
 * @param {ServerConfig} server
 * @param {{
 *   stdout: { write: (s: string) => void },
 *   stderr: { write: (s: string) => void },
 *   isTTY: boolean,
 *   prompt: (q: string) => Promise<string>,
 *   makeRegistry: (s: ServerConfig) => ConfigRegistry,
 * }} ctx
 * @returns {Promise<number>}
 */
async function runDelete(parsed, server, ctx) {
  if (!parsed.yes) {
    if (!ctx.isTTY) {
      ctx.stderr.write('error: refusing to delete without --yes (no TTY for confirmation)\n')
      return 1
    }
    const answer = await ctx.prompt(`Delete config for ${parsed.gatewayId}? [y/N] `)
    if (!/^y(es)?$/i.test(answer)) {
      ctx.stdout.write('  Cancelled.\n')
      return 0
    }
  }
  const registry = ctx.makeRegistry(server)
  /** @type {boolean} */
  let removed
  try {
    removed = deleteConfig(registry, parsed.gatewayId)
  } catch (err) {
    ctx.stderr.write(`error: ${formatError(err)}\n`)
    return 1
  }
  if (removed) {
    ctx.stdout.write(`✓ Deleted config for ${parsed.gatewayId}\n`)
  } else {
    ctx.stdout.write(`  No config registered for ${parsed.gatewayId}; nothing to delete.\n`)
  }
  return 0
}

/**
 * @param {ParsedTokenIssue} parsed
 * @param {ServerConfig} server
 * @param {{
 *   stdout: { write: (s: string) => void },
 *   stderr: { write: (s: string) => void },
 *   makeBootstrapStore: (p: string) => BootstrapStore,
 * }} ctx
 * @returns {number}
 */
function runTokenIssue(parsed, server, ctx) {
  const storePath = server.identity_issuer.bootstrap_store_path
  if (!storePath) {
    ctx.stderr.write(
      'error: server.identity_issuer.bootstrap_store_path is not set; ' +
      'add it to the server config so bootstrap tokens can be issued\n'
    )
    return 1
  }
  const store = ctx.makeBootstrapStore(storePath)
  const ttlSeconds = parsed.ttlSeconds ?? server.identity_issuer.bootstrap_ttl_seconds
  /** @type {{ token: string, expiresAt: number }} */
  let result
  try {
    result = ttlSeconds !== undefined
      ? store.register({ gatewayId: parsed.gatewayId, ttlSeconds })
      : store.register({ gatewayId: parsed.gatewayId })
  } catch (err) {
    ctx.stderr.write(`error: ${formatError(err)}\n`)
    return 1
  }
  // Print the plaintext token on its own line so it round-trips through pipes
  // and copy-paste cleanly. The expiry goes to stderr so the operator sees it
  // interactively without polluting `--quiet`-style scripted captures.
  ctx.stdout.write(result.token + '\n')
  ctx.stderr.write(
    `Token issued for ${parsed.gatewayId}; expires at ${formatExpiry(result.expiresAt)}.\n` +
    'Hand this token to the gateway in central_server.identity.bootstrap_token. It can be redeemed exactly once.\n'
  )
  return 0
}

/**
 * @param {ParsedTokenRevoke} parsed
 * @param {ServerConfig} server
 * @param {{
 *   stdout: { write: (s: string) => void },
 *   makeBootstrapStore: (p: string) => BootstrapStore,
 * }} ctx
 * @returns {number}
 */
function runTokenRevoke(parsed, server, ctx) {
  const storePath = server.identity_issuer.bootstrap_store_path
  if (!storePath) {
    // No store configured ⇒ no tokens exist. Treat as no-op rather than error;
    // a revoke that finds nothing has the same effect either way.
    ctx.stdout.write(`  No bootstrap store configured; 0 tokens revoked for ${parsed.gatewayId}.\n`)
    return 0
  }
  const store = ctx.makeBootstrapStore(storePath)
  const removed = store.revokeUnusedForGateway(parsed.gatewayId)
  ctx.stdout.write(`✓ Revoked ${removed} unused bootstrap token${removed === 1 ? '' : 's'} for ${parsed.gatewayId}\n`)
  return 0
}

/**
 * @param {number} epochSeconds
 * @returns {string}
 */
function formatExpiry(epochSeconds) {
  return new Date(epochSeconds * 1000).toISOString()
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}
