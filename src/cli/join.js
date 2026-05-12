import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { runWithConfig } from '../cli.js'
import { defaultConfigPath, isNpxBinPath } from './common.js'
import { validateCollectivusConfig } from '../config.js'
import { IdentityClient } from '../gateway/identity.js'

/**
 * @import { CollectivusConfig } from '../types.js'
 * @import { DaemonInstallOptions } from '../daemon/types.d.ts'
 * @import { InstallHooks } from './types.d.ts'
 */

const USAGE = `Usage:
  ctvs join <join-code> --rendezvous <url>

Options:
  --rendezvous <url>  Rendezvous server base URL
  --help, -h          Show this help`

/**
 * @param {string[]} argv
 * @returns {{ help: true, error?: undefined } | { help: false, joinCode: string, rendezvous: string, error?: undefined } | { help: false, error: string }}
 */
export function parseJoinArgs(argv) {
  /** @type {string | undefined} */
  let joinCode
  /** @type {string | undefined} */
  let rendezvous

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { help: true }
    if (arg === '--rendezvous' || arg.startsWith('--rendezvous=')) {
      const value = arg === '--rendezvous' ? argv[++i] : arg.slice('--rendezvous='.length)
      if (!value) return parseError('--rendezvous requires a URL')
      if (!isHttpUrl(value)) return parseError('--rendezvous requires an http(s) URL')
      rendezvous = value
      continue
    }
    if (arg.startsWith('-')) return parseError(`unknown argument: ${arg}`)
    if (joinCode !== undefined) return parseError(`unexpected positional argument: ${arg}`)
    joinCode = arg
  }

  if (!joinCode) return parseError('join-code is required')
  if (!rendezvous) return parseError('--rendezvous is required')
  return { help: false, joinCode, rendezvous }
}

/**
 * @param {string[]} argv
 * @param {NodeJS.ProcessEnv} env
 * @param {{
 *   stdout?: { write: (s: string) => void },
 *   stderr?: { write: (s: string) => void },
 *   fetchFn?: typeof fetch,
 *   onShutdownRequested?: (handler: (signal: string) => void) => void,
 *   identityPersistedPath?: string,
 *   binPath?: string,
 *   configPath?: string,
 *   logDir?: string,
 *   settingsPath?: string,
 *   installGlobal?: () => Promise<boolean>,
 *   resolveGlobalBinPath?: () => Promise<string>,
 *   writeConfig?: (configPath: string, config: CollectivusConfig) => void,
 *   installLaunchAgent?: (opts: DaemonInstallOptions) => Promise<void>,
 *   attach?: InstallHooks['attach'],
 *   runInstall?: (argv: string[], hooks?: InstallHooks) => Promise<number>,
 * }} [hooks]
 * @returns {Promise<number>}
 */
export async function runJoin(argv, env, hooks = {}) {
  const stdout = hooks.stdout ?? process.stdout
  const stderr = hooks.stderr ?? process.stderr
  const binPath = hooks.binPath ?? process.argv[1] ?? ''
  const parsed = parseJoinArgs(argv)
  if (parsed.help) {
    stdout.write(USAGE + '\n')
    return 0
  }
  if (parsed.error) {
    stderr.write(`error: ${parsed.error}\n\n${USAGE}\n`)
    return 2
  }
  const opts = /** @type {{ help: false, joinCode: string, rendezvous: string }} */ (parsed)

  /** @type {Awaited<ReturnType<typeof resolveJoinCode>>} */
  let resolved
  try {
    resolved = await resolveJoinCode(opts.joinCode, opts.rendezvous, hooks.fetchFn ?? fetch)
  } catch (err) {
    stderr.write(`error: ${formatError(err)}\n`)
    return 1
  }

  /** @type {CollectivusConfig} */
  let config
  try {
    config = await fetchJoinedGatewayConfig(opts.joinCode, resolved.connect_url, hooks.fetchFn ?? fetch)
  } catch (err) {
    stderr.write(`error: ${formatError(err)}\n`)
    return 1
  }

  if (isNpxCollectivusBinPath(binPath)) {
    return installJoinedGateway(config, resolved, {
      stdout,
      stderr,
      fetchFn: hooks.fetchFn ?? fetch,
      configPath: hooks.configPath,
      logDir: hooks.logDir,
      settingsPath: hooks.settingsPath,
      identityPersistedPath: hooks.identityPersistedPath,
      installGlobal: hooks.installGlobal,
      resolveGlobalBinPath: hooks.resolveGlobalBinPath,
      writeConfig: hooks.writeConfig,
      installLaunchAgent: hooks.installLaunchAgent,
      attach: hooks.attach,
      runInstall: hooks.runInstall,
    })
  }

  return runWithConfig(config, env, {
    stdout,
    stderr,
    onShutdownRequested: hooks.onShutdownRequested,
    identityPersistedPath: hooks.identityPersistedPath,
  })
}

/**
 * @param {CollectivusConfig} config
 * @param {{ connect_url: string, gateway_id: string, expires_at: string, display_name?: string }} resolved
 * @param {{
 *   stdout: { write: (s: string) => void },
 *   stderr: { write: (s: string) => void },
 *   fetchFn: typeof fetch,
 *   configPath?: string,
 *   logDir?: string,
 *   settingsPath?: string,
 *   identityPersistedPath?: string,
 *   installGlobal?: () => Promise<boolean>,
 *   resolveGlobalBinPath?: () => Promise<string>,
 *   writeConfig?: (configPath: string, config: CollectivusConfig) => void,
 *   installLaunchAgent?: (opts: DaemonInstallOptions) => Promise<void>,
 *   attach?: InstallHooks['attach'],
 *   runInstall?: (argv: string[], hooks?: InstallHooks) => Promise<number>,
 * }} opts
 * @returns {Promise<number>}
 */
async function installJoinedGateway(config, resolved, opts) {
  const configPath = opts.configPath ?? defaultConfigPath()
  const installGlobal = opts.installGlobal ?? defaultInstallGlobalCollectivus
  const resolveGlobalBinPath = opts.resolveGlobalBinPath ?? defaultResolveGlobalBinPath
  const writeConfig = opts.writeConfig ?? writeConfigAtomic

  const display = resolved.display_name ? ` (${resolved.display_name})` : ''
  opts.stdout.write(`Resolved join code for ${resolved.gateway_id}${display}; Central server ${resolved.connect_url}\n`)
  opts.stdout.write('Installing collectivus globally with npm...\n')

  /** @type {boolean} */
  let installed
  try {
    installed = await installGlobal()
  } catch (err) {
    opts.stderr.write(`error: failed to install collectivus globally: ${formatError(err)}\n`)
    return 1
  }
  if (!installed) {
    opts.stderr.write('error: npm install -g collectivus failed\n')
    return 1
  }

  /** @type {string} */
  let globalBinPath
  try {
    globalBinPath = await resolveGlobalBinPath()
  } catch (err) {
    opts.stderr.write(`error: failed to locate globally installed collectivus: ${formatError(err)}\n`)
    return 1
  }

  try {
    config = await fetchAuthenticatedInstallConfig(config, {
      fetchFn: opts.fetchFn,
      stdout: opts.stdout,
      stderr: opts.stderr,
      identityPersistedPath: opts.identityPersistedPath,
    })
  } catch (err) {
    opts.stderr.write(`error: failed to prepare gateway config: ${formatError(err)}\n`)
    return 1
  }

  try {
    writeConfig(configPath, config)
  } catch (err) {
    opts.stderr.write(`error: failed to write gateway config: ${formatError(err)}\n`)
    return 1
  }
  opts.stdout.write(`✓ Gateway config written to ${configPath}\n`)

  const runInstallFn = opts.runInstall ?? (await import('./install.js')).runInstall
  return runInstallFn(['--config', configPath, '--yes'], {
    stdout: opts.stdout,
    stderr: opts.stderr,
    binPath: globalBinPath,
    ...opts.logDir !== undefined ? { logDir: opts.logDir } : {},
    ...opts.settingsPath !== undefined ? { settingsPath: opts.settingsPath } : {},
    ...opts.installLaunchAgent !== undefined ? { installLaunchAgent: opts.installLaunchAgent } : {},
    ...opts.attach !== undefined ? { attach: opts.attach } : {},
  })
}

/**
 * Consume the one-shot bootstrap token during the npx install flow, then use
 * the resulting JWT to fetch the canonical per-gateway config. This makes the
 * persisted config match what Central vends at `/v1/config`; the daemon starts
 * from the persisted identity instead of replaying the bootstrap token.
 *
 * If Central has not registered a per-gateway config yet, keep the starter
 * config so the daemon can poll until one appears. The consumed token is
 * removed from that fallback config because replaying it would fail.
 *
 * @param {CollectivusConfig} config
 * @param {{
 *   fetchFn: typeof fetch,
 *   stdout: { write: (s: string) => void },
 *   stderr: { write: (s: string) => void },
 *   identityPersistedPath?: string,
 * }} opts
 * @returns {Promise<CollectivusConfig>}
 */
async function fetchAuthenticatedInstallConfig(config, opts) {
  if (config.role !== 'gateway' || !config.central_server) return config
  const bootstrapToken = config.central_server.identity.bootstrap_token
  if (typeof bootstrapToken !== 'string' || bootstrapToken.length === 0) return config

  const identityClient = new IdentityClient(config.central_server, {
    fetchFn: opts.fetchFn,
    ...opts.identityPersistedPath !== undefined ? { persistedPath: opts.identityPersistedPath } : {},
  })
  await identityClient.bootstrap()
  const id = identityClient.identity?.gateway_id ?? 'gateway'
  opts.stdout.write(`✓ Identity bootstrapped for ${id}\n`)

  const jwt = await identityClient.getCurrentJwt()
  const response = await fetchGatewayConfig(config.central_server.url, jwt, opts.fetchFn)
  if (response.status === 404) {
    opts.stderr.write(
      'warning: Central server has no registered config for this gateway yet; ' +
      'writing starter config and the daemon will keep polling\n'
    )
    return withoutBootstrapToken(config)
  }
  if (!response.ok) {
    opts.stderr.write(
      `warning: failed to fetch authenticated gateway config: ${await readErrorDetail(response)}; ` +
      'writing starter config and the daemon will retry through config polling\n'
    )
    return withoutBootstrapToken(config)
  }

  /** @type {unknown} */
  let body
  try {
    body = await response.json()
  } catch (err) {
    opts.stderr.write(
      `warning: authenticated gateway config response was invalid JSON: ${formatError(err)}; ` +
      'writing starter config and the daemon will retry through config polling\n'
    )
    return withoutBootstrapToken(config)
  }
  try {
    validateCollectivusConfig(body)
  } catch (err) {
    opts.stderr.write(
      `warning: authenticated gateway config failed validation: ${formatError(err)}; ` +
      'writing starter config and the daemon will retry through config polling\n'
    )
    return withoutBootstrapToken(config)
  }
  opts.stdout.write('✓ Gateway config fetched from Central server\n')
  return /** @type {CollectivusConfig} */ (body)
}

/**
 * @param {string} centralUrl
 * @param {string} jwt
 * @param {typeof fetch} fetchFn
 * @returns {Promise<Response>}
 */
async function fetchGatewayConfig(centralUrl, jwt, fetchFn) {
  try {
    return await fetchFn(joinUrl(centralUrl, '/v1/config'), {
      method: 'GET',
      headers: { authorization: `Bearer ${jwt}` },
    })
  } catch (err) {
    throw new Error(`failed to reach Central server ${centralUrl}: ${formatError(err)}`)
  }
}

/**
 * @param {CollectivusConfig} config
 * @returns {CollectivusConfig}
 */
function withoutBootstrapToken(config) {
  const central = config.central_server
  if (!central) return config
  const identity = { ...central.identity }
  delete identity.bootstrap_token
  return {
    ...config,
    central_server: {
      ...central,
      identity,
    },
  }
}

/**
 * @param {string} joinCode
 * @param {string} rendezvousUrl
 * @param {typeof fetch} fetchFn
 * @returns {Promise<{ connect_url: string, gateway_id: string, expires_at: string, display_name?: string }>}
 */
export async function resolveJoinCode(joinCode, rendezvousUrl, fetchFn = fetch) {
  const url = joinUrl(rendezvousUrl, '/v1/rendezvous/resolve')
  let response
  try {
    response = await fetchFn(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ join_code: joinCode }),
    })
  } catch (err) {
    throw new Error(`failed to reach rendezvous server ${rendezvousUrl}: ${formatError(err)}`)
  }

  if (!response.ok) {
    throw new Error(`rendezvous resolve failed: ${await readErrorDetail(response)}`)
  }

  /** @type {unknown} */
  let body
  try {
    body = await response.json()
  } catch (err) {
    throw new Error(`rendezvous resolve failed: invalid JSON response: ${formatError(err)}`)
  }
  if (!isPlainObject(body)) {
    throw new Error('rendezvous resolve failed: response is not an object')
  }
  if (typeof body.connect_url !== 'string' || !isHttpUrl(body.connect_url)) {
    throw new Error('rendezvous resolve failed: response missing http(s) connect_url')
  }
  if (typeof body.gateway_id !== 'string' || body.gateway_id.length === 0) {
    throw new Error('rendezvous resolve failed: response missing gateway_id')
  }
  if (typeof body.expires_at !== 'string' || !Number.isFinite(Date.parse(body.expires_at))) {
    throw new Error('rendezvous resolve failed: response missing expires_at')
  }
  /** @type {{ connect_url: string, gateway_id: string, expires_at: string, display_name?: string }} */
  const resolved = {
    connect_url: body.connect_url.replace(/\/+$/, ''),
    gateway_id: body.gateway_id,
    expires_at: new Date(Date.parse(body.expires_at)).toISOString(),
  }
  if (typeof body.display_name === 'string' && body.display_name.length > 0) {
    resolved.display_name = body.display_name
  }
  return resolved
}

/**
 * Fetch the Central server's bootstrap config without consuming the one-shot
 * join token, then overlay that token locally so first daemon start can
 * acquire identity even when the registered config keeps identity empty.
 *
 * @param {string} joinCode
 * @param {string} centralUrl
 * @param {typeof fetch} fetchFn
 * @returns {Promise<CollectivusConfig>}
 */
async function fetchJoinedGatewayConfig(joinCode, centralUrl, fetchFn = fetch) {
  const url = new URL(joinUrl(centralUrl, '/v1/bootstrap-config'))
  url.searchParams.set('token', joinCode)

  let response
  try {
    response = await fetchFn(url.toString(), { method: 'GET' })
  } catch (err) {
    throw new Error(`failed to fetch gateway config from ${centralUrl}: ${formatError(err)}`)
  }

  if (!response.ok) {
    throw new Error(`failed to fetch gateway config from ${centralUrl}: ${await readErrorDetail(response)}`)
  }

  /** @type {unknown} */
  let body
  try {
    body = await response.json()
  } catch (err) {
    throw new Error(`failed to fetch gateway config from ${centralUrl}: invalid JSON response: ${formatError(err)}`)
  }
  if (!isPlainObject(body)) {
    throw new Error(`failed to fetch gateway config from ${centralUrl}: response is not an object`)
  }

  const config = withBootstrapToken(body, joinCode, centralUrl)
  try {
    validateCollectivusConfig(config)
  } catch (err) {
    throw new Error(`failed to fetch gateway config from ${centralUrl}: invalid config: ${formatError(err)}`)
  }
  return /** @type {CollectivusConfig} */ (config)
}

/**
 * @param {Record<string, unknown>} config
 * @param {string} joinCode
 * @param {string} centralUrl
 * @returns {Record<string, unknown>}
 */
function withBootstrapToken(config, joinCode, centralUrl) {
  const central = isPlainObject(config.central_server)
    ? config.central_server
    : { url: centralUrl, identity: {} }
  const identity = isPlainObject(central.identity) ? central.identity : {}
  return {
    ...config,
    central_server: {
      ...central,
      url: typeof central.url === 'string' ? central.url : centralUrl,
      identity: {
        ...identity,
        bootstrap_token: joinCode,
      },
    },
  }
}

/**
 * @param {string} message
 * @returns {{ help: false, error: string }}
 */
function parseError(message) {
  return { help: false, error: message }
}

/**
 * @param {string} value
 * @returns {boolean}
 */
function isHttpUrl(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * @param {string} base
 * @param {string} suffix
 * @returns {string}
 */
function joinUrl(base, suffix) {
  const baseWithSlash = base.endsWith('/') ? base : `${base}/`
  return new URL(suffix.replace(/^\//, ''), baseWithSlash).toString()
}

/**
 * Install the current published package into npm's global prefix.
 *
 * @returns {Promise<boolean>}
 */
async function defaultInstallGlobalCollectivus() {
  const exitCode = await runInherited(defaultNpmPath(), ['install', '-g', 'collectivus'])
  return exitCode === 0
}

/**
 * @returns {Promise<string>}
 */
async function defaultResolveGlobalBinPath() {
  const result = await runCaptured(defaultNpmPath(), ['root', '-g'])
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `npm root -g exited ${result.exitCode}`)
  }
  const root = result.stdout.trim()
  if (!root) throw new Error('npm root -g returned an empty path')
  const binPath = path.join(root, 'collectivus', 'bin', 'cli.js')
  if (!fs.existsSync(binPath)) {
    throw new Error(`${binPath} does not exist after npm install -g collectivus`)
  }
  return binPath
}

/**
 * @returns {string}
 */
function defaultNpmPath() {
  const name = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  return path.join(path.dirname(process.execPath), name)
}

/**
 * @param {string} configPath
 * @param {CollectivusConfig} config
 * @returns {void}
 */
function writeConfigAtomic(configPath, config) {
  const dir = path.dirname(configPath)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, `.${path.basename(configPath)}.${process.pid}.${Date.now()}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, configPath)
}

/**
 * @param {string} binPath
 * @returns {boolean}
 */
function isNpxCollectivusBinPath(binPath) {
  if (!isNpxBinPath(binPath)) return false
  return /[/\\]node_modules[/\\]collectivus[/\\]bin[/\\]cli\.js$/.test(binPath) ||
    /[/\\]node_modules[/\\]\.bin[/\\](collectivus|ctvs)(\.cmd)?$/.test(binPath)
}

/**
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<number>}
 */
function runInherited(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit' })
    child.once('error', reject)
    child.once('exit', (code) => resolve(code === null ? -1 : code))
  })
}

/**
 * @param {string} command
 * @param {string[]} args
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>}
 */
function runCaptured(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.once('error', reject)
    child.once('exit', (code) => resolve({ exitCode: code === null ? -1 : code, stdout, stderr }))
  })
}

/**
 * @param {Response} response
 * @returns {Promise<string>}
 */
async function readErrorDetail(response) {
  /** @type {unknown} */
  let parsed
  try {
    parsed = await response.json()
  } catch {
    return `HTTP ${response.status} ${response.statusText}`
  }
  if (isPlainObject(parsed) && typeof parsed.error === 'string') {
    return `${parsed.error} (HTTP ${response.status})`
  }
  return `HTTP ${response.status} ${response.statusText}`
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}
