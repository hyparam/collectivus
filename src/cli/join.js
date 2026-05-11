import process from 'node:process'
import { runWithConfig } from '../cli.js'

/**
 * @import { CollectivusConfig } from '../types.js'
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
 * }} [hooks]
 * @returns {Promise<number>}
 */
export async function runJoin(argv, env, hooks = {}) {
  const stdout = hooks.stdout ?? process.stdout
  const stderr = hooks.stderr ?? process.stderr
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
  const config = {
    version: 1,
    role: 'gateway',
    central_server: {
      url: resolved.connect_url,
      identity: {
        bootstrap_token: opts.joinCode,
      },
    },
  }

  return runWithConfig(config, env, {
    stdout,
    stderr,
    onShutdownRequested: hooks.onShutdownRequested,
    identityPersistedPath: hooks.identityPersistedPath,
  })
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
