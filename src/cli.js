import process from 'node:process'
import { Collector } from './collector.js'
import { ConfigError, loadConfig } from './config.js'
import { Proxy } from './proxy.js'
import { Recorder } from './recorder.js'
import { FileSink } from './sinks/file.js'

const USAGE = `Usage:
  collectivus --config <path>                  Run with config file
  collectivus --config <path> --print-config   Load config, print resolved JSON, exit
  collectivus --help                           Show this help`

const DRAIN_TIMEOUT_MS = 5000

/**
 * @typedef {{ mode: 'help' }} HelpResult
 * @typedef {{ mode: 'error', message: string, exitCode: number }} ErrorResult
 * @typedef {{
 *   mode: 'config',
 *   configPath: string,
 *   printConfig: boolean,
 * }} ConfigResult
 * @typedef {HelpResult | ErrorResult | ConfigResult} ParseResult
 */

/**
 * Parse CLI arguments into a structured result.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {ParseResult}
 */
export function parseArgs(argv) {
  /** @type {string | null} */
  let configPath = null
  let printConfig = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    if (arg === '--help' || arg === '-h') {
      return { mode: 'help' }
    }

    if (arg === '--config' || arg.startsWith('--config=')) {
      const value = arg === '--config' ? argv[++i] : arg.slice('--config='.length)
      if (!value) return parseError('--config requires a path')
      configPath = value
      continue
    }

    if (arg === '--print-config') {
      printConfig = true
      continue
    }

    return parseError(`unknown argument: ${arg}`)
  }

  if (configPath === null) {
    return parseError('--config <path> is required')
  }

  return { mode: 'config', configPath, printConfig }
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
 * @param {NodeJS.ProcessEnv} _env Environment variables (unused; reserved).
 * @param {{
 *   stdout?: { write: (s: string) => void },
 *   stderr?: { write: (s: string) => void },
 *   onShutdownRequested?: (handler: (signal: string) => void) => void,
 * }} [hooks]
 * @returns {Promise<number>}
 */
export async function run(argv, _env, hooks = {}) {
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

  return runLifecycle(buildConfigListeners(config), stdout, stderr, onShutdownRequested)
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
 * @returns {ListenerFactory[]}
 */
function buildConfigListeners(config) {
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
    if (!config.sink) {
      throw new Error('proxy is configured but sink is missing')
    }
    const proxyConfig = config.proxy
    const sinkDir = config.sink.dir
    factories.push(async () => {
      const sink = new FileSink(sinkDir)
      const recorder = new Recorder({ sink, redactHeaders: proxyConfig.redact_headers })
      const proxy = new Proxy(proxyConfig, { recorder })
      await proxy.start()
      const effective = effectiveBinding(proxy.server, proxy.host, proxy.port)
      return {
        description: `Proxy listener bound on ${effective}, recording to ${sinkDir}/proxy.jsonl`,
        // Stop accepting new connections, then flush+close the sink so the
        // final exchange row of any in-flight request lands before exit.
        stop: async () => {
          await proxy.stop()
          await sink.close()
        },
      }
    })
  }

  return factories
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
