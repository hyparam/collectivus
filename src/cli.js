import process from 'node:process'
import { Collector } from './collector.js'
import { ConfigError, loadConfig } from './config.js'

const USAGE = `Usage:
  collectivus --config <path>                  Run with config file
  collectivus --config <path> --print-config   Load config, print resolved JSON, exit
  collectivus [--port <n>] [--output <dir>]    Legacy OTLP-only mode
  collectivus                                  Legacy default (port 4318, ./otel-data)
  collectivus --help                           Show this help

Environment (legacy mode):
  COLLECTIVUS_PORT        Override default port
  COLLECTIVUS_OUTPUT_DIR  Override default output directory`

const DRAIN_TIMEOUT_MS = 5000

/**
 * @typedef {{ mode: 'help' }} HelpResult
 * @typedef {{ mode: 'error', message: string, exitCode: number }} ErrorResult
 * @typedef {{
 *   mode: 'legacy',
 *   port: number | undefined,
 *   outputDir: string | undefined,
 *   bare: boolean,
 * }} LegacyResult
 * @typedef {{
 *   mode: 'config',
 *   configPath: string,
 *   printConfig: boolean,
 * }} ConfigResult
 * @typedef {HelpResult | ErrorResult | LegacyResult | ConfigResult} ParseResult
 */

/**
 * Parse CLI arguments into a structured result.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {ParseResult}
 */
export function parseArgs(argv) {
  /** @type {'config' | 'legacy' | null} */
  let mode = null
  /** @type {string | null} */
  let configPath = null
  let printConfig = false
  /** @type {number | undefined} */
  let port
  /** @type {string | undefined} */
  let outputDir

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    if (arg === '--help' || arg === '-h') {
      return { mode: 'help' }
    }

    if (arg === '--config' || arg.startsWith('--config=')) {
      const value = arg === '--config' ? argv[++i] : arg.slice('--config='.length)
      if (!value) return parseError('--config requires a path')
      if (mode === 'legacy') return parseError('--config cannot be combined with --port/--output')
      mode = 'config'
      configPath = value
      continue
    }

    if (arg === '--print-config') {
      printConfig = true
      continue
    }

    if (arg === '--port' || arg.startsWith('--port=')) {
      const value = arg === '--port' ? argv[++i] : arg.slice('--port='.length)
      if (!value) return parseError('--port requires a number')
      if (!/^\d+$/.test(value)) {
        return parseError(`--port: not a valid port (got "${value}")`)
      }
      const n = Number.parseInt(value, 10)
      if (n > 65535) {
        return parseError(`--port: not a valid port (got "${value}")`)
      }
      if (mode === 'config') return parseError('--port cannot be combined with --config')
      mode = 'legacy'
      port = n
      continue
    }

    if (arg === '--output' || arg.startsWith('--output=')) {
      const value = arg === '--output' ? argv[++i] : arg.slice('--output='.length)
      if (!value) return parseError('--output requires a directory')
      if (mode === 'config') return parseError('--output cannot be combined with --config')
      mode = 'legacy'
      outputDir = value
      continue
    }

    return parseError(`unknown argument: ${arg}`)
  }

  if (printConfig && mode !== 'config') {
    return parseError('--print-config requires --config <path>')
  }

  if (mode === 'config' && configPath !== null) {
    return { mode: 'config', configPath, printConfig }
  }

  return { mode: 'legacy', port, outputDir, bare: mode === null }
}

/**
 * @param {string} message
 * @returns {ErrorResult}
 */
function parseError(message) {
  return { mode: 'error', message, exitCode: 2 }
}

/**
 * Run the CLI to completion.
 *
 * Resolves with the process exit code. Tests inject `hooks` to capture output
 * and trigger shutdown without sending real signals; production wires real
 * stdio and process signals.
 *
 * @param {string[]} argv CLI arguments (without node/script name).
 * @param {NodeJS.ProcessEnv} env Environment variables.
 * @param {{
 *   stdout?: { write: (s: string) => void },
 *   stderr?: { write: (s: string) => void },
 *   onShutdownRequested?: (handler: (signal: string) => void) => void,
 * }} [hooks]
 * @returns {Promise<number>}
 */
export async function run(argv, env, hooks = {}) {
  const stdout = hooks.stdout ?? process.stdout
  const stderr = hooks.stderr ?? process.stderr
  const onShutdownRequested = hooks.onShutdownRequested ?? defaultSignalWiring

  const parsed = parseArgs(argv)

  if (parsed.mode === 'help') {
    stdout.write(USAGE + '\n')
    return 0
  }
  if (parsed.mode === 'error') {
    stderr.write(`error: ${parsed.message}\n\n${USAGE}\n`)
    return parsed.exitCode
  }

  if (parsed.mode === 'config') {
    /** @type {import('./config.js').CollectivusConfig} */
    let config
    try {
      config = loadConfig(parsed.configPath)
    } catch (err) {
      if (err instanceof ConfigError) {
        stderr.write(`config error: ${err.message}\n`)
        return 1
      }
      throw err
    }

    if (parsed.printConfig) {
      stdout.write(JSON.stringify(config, null, 2) + '\n')
      return 0
    }

    return runLifecycle(buildConfigListeners(config, stderr), stdout, stderr, onShutdownRequested)
  }

  if (parsed.bare) {
    stderr.write('Warning: running without --config is deprecated. Use --config <path> for the new config-driven mode.\n')
  }

  const legacyPort = parsed.port ?? envPort(env)
  const legacyOutputDir = parsed.outputDir ?? env.COLLECTIVUS_OUTPUT_DIR ?? undefined

  return runLifecycle(
    [() => buildLegacyListener(legacyPort, legacyOutputDir)],
    stdout,
    stderr,
    onShutdownRequested
  )
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {number | undefined}
 */
function envPort(env) {
  if (!env.COLLECTIVUS_PORT) return undefined
  const n = Number.parseInt(env.COLLECTIVUS_PORT, 10)
  if (!Number.isInteger(n) || n < 0 || n > 65535) return undefined
  return n
}

/**
 * @typedef {{
 *   description: string,
 *   stop: () => Promise<void>,
 * }} StartedListener
 */

/**
 * @typedef {() => Promise<StartedListener>} ListenerFactory
 */

/**
 * @param {import('./config.js').CollectivusConfig} config
 * @param {{ write: (s: string) => void }} stderr
 * @returns {ListenerFactory[]}
 */
function buildConfigListeners(config, stderr) {
  /** @type {ListenerFactory[]} */
  const factories = []

  if (config.otel) {
    const { listen } = config.otel
    const outputDir = config.sink?.dir ?? './otel-data'
    factories.push(async () => {
      const { host, port } = parseListen(listen)
      const collector = new Collector({ host, port, outputDir })
      await collector.start()
      const effective = effectiveBinding(collector.server, host, port)
      return {
        description: `OTLP listener bound on ${effective}, writing to ${outputDir}`,
        stop: () => collector.stop(),
      }
    })
  }

  if (config.proxy) {
    stderr.write(`Warning: proxy listener is not yet implemented in this build (config requested ${config.proxy.listen}); skipping.\n`)
  }

  return factories
}

/**
 * @param {number | undefined} port
 * @param {string | undefined} outputDir
 * @returns {Promise<StartedListener>}
 */
async function buildLegacyListener(port, outputDir) {
  const collector = new Collector({ port, outputDir })
  await collector.start()
  const effective = effectiveBinding(collector.server, undefined, collector.port)
  return {
    description: `Collectivus listening on ${effective}, writing to ${collector.outputDir}`,
    stop: () => collector.stop(),
  }
}

/**
 * @param {ListenerFactory[]} factories
 * @param {{ write: (s: string) => void }} stdout
 * @param {{ write: (s: string) => void }} stderr
 * @param {(handler: (signal: string) => void) => void} onShutdownRequested
 * @returns {Promise<number>}
 */
async function runLifecycle(factories, stdout, stderr, onShutdownRequested) {
  if (factories.length === 0) {
    stderr.write('error: no listeners configured\n')
    return 1
  }

  // Register the shutdown handler before starting listeners so a signal
  // arriving during bind doesn't fall through to Node's default (terminate).
  const shutdownPromise = new Promise((resolve) => {
    onShutdownRequested((signal) => {
      stdout.write(`Received ${signal}, shutting down...\n`)
      resolve(undefined)
    })
  })

  /** @type {StartedListener[]} */
  const started = []
  for (const factory of factories) {
    try {
      const listener = await factory()
      stdout.write(listener.description + '\n')
      started.push(listener)
    } catch (err) {
      stderr.write(`error: failed to start listener: ${formatError(err)}\n`)
      await stopAll(started, stderr)
      return 1
    }
  }

  await shutdownPromise
  await stopAll(started, stderr)
  stdout.write('Shutdown complete.\n')
  return 0
}

/**
 * @param {StartedListener[]} started
 * @param {{ write: (s: string) => void }} stderr
 * @returns {Promise<void>}
 */
async function stopAll(started, stderr) {
  if (started.length === 0) return
  /** @type {Promise<void>[]} */
  const stops = started.map(async (l) => {
    try {
      await l.stop()
    } catch (err) {
      stderr.write(`warning: error stopping listener: ${formatError(err)}\n`)
    }
  })
  /** @type {Promise<'timeout'>} */
  const timeout = new Promise((resolve) => {
    const t = setTimeout(() => resolve('timeout'), DRAIN_TIMEOUT_MS)
    if (typeof t.unref === 'function') t.unref()
  })
  const outcome = await Promise.race([Promise.all(stops).then(() => 'done'), timeout])
  if (outcome === 'timeout') {
    stderr.write(`warning: drain exceeded ${DRAIN_TIMEOUT_MS}ms; forcing exit\n`)
  }
}

/**
 * @param {(signal: string) => void} handler
 * @returns {void}
 */
function defaultSignalWiring(handler) {
  process.once('SIGINT', () => handler('SIGINT'))
  process.once('SIGTERM', () => handler('SIGTERM'))
}

/**
 * Parse a `host:port` listen string. Bracketed IPv6 addresses are unwrapped.
 *
 * @param {string} value
 * @returns {{ host: string, port: number }}
 */
function parseListen(value) {
  let host = ''
  let portStr = ''
  if (value.startsWith('[')) {
    const close = value.indexOf(']')
    if (close === -1) throw new Error(`invalid listen address: ${value}`)
    host = value.slice(1, close)
    if (value[close + 1] !== ':') throw new Error(`invalid listen address: ${value}`)
    portStr = value.slice(close + 2)
  } else {
    const colon = value.lastIndexOf(':')
    if (colon <= 0) throw new Error(`invalid listen address: ${value}`)
    host = value.slice(0, colon)
    portStr = value.slice(colon + 1)
  }
  const port = Number.parseInt(portStr, 10)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`invalid port in listen address: ${value}`)
  }
  return { host, port }
}

/**
 * @param {import('node:http').Server | null} server
 * @param {string | undefined} configuredHost
 * @param {number} configuredPort
 * @returns {string}
 */
function effectiveBinding(server, configuredHost, configuredPort) {
  const addr = server?.address()
  if (addr && typeof addr === 'object') {
    const host = configuredHost ?? addr.address
    return `${formatHost(host)}:${addr.port}`
  }
  return `${formatHost(configuredHost ?? '0.0.0.0')}:${configuredPort}`
}

/**
 * @param {string} host
 * @returns {string}
 */
function formatHost(host) {
  if (host.includes(':') && !host.startsWith('[')) return `[${host}]`
  return host
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  if (err && typeof err === 'object' && 'code' in err && 'message' in err) {
    return `${err.code}: ${err.message}`
  }
  return err instanceof Error ? err.message : String(err)
}
