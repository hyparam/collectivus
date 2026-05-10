import process from 'node:process'
import { readPackageVersion } from './cli/common.js'
import { Collector } from './collector.js'
import { ConfigError, loadConfigAsync } from './config.js'
import { Proxy } from './proxy.js'
import { Recorder } from './recorder.js'
import { FileSink } from './sinks/file.js'
import { isSupervised, selfUpdate } from './update.js'
import { createScheduler } from './upload/scheduler.js'

/**
 * @import { Server } from 'node:http'
 * @import { ErrorResult, ParseResult, StartedListener, ListenerFactory, CollectivusConfig } from './types.js'
 */

const USAGE = `Usage:
  collectivus --config <path|url>              Run with config file or http(s) URL
  collectivus --config <path|url> --print-config
                                               Load config, print resolved JSON, exit
  collectivus --config <path|url> --strict     Reject unknown top-level config keys
  collectivus --help                           Show this help
  collectivus --version                        Print program version

Commands:
  collectivus install [--config <path|url>]    Install the background daemon
  collectivus uninstall [--detach] [--client claude|codex|all]
                                               Remove the daemon (and detach selected clients)
  collectivus attach [--config <path|url>] [--port <n>] [--client claude|codex|all]
                                               Point Claude Code or Codex at the local proxy
  collectivus detach [--client claude|codex|all]
                                               Restore Claude Code and/or Codex config
  collectivus status                           Report daemon, config, recordings, attach state
  collectivus export --config <path|url> [...] Convert recorded JSONL to Parquet`

const DRAIN_TIMEOUT_MS = 5000
const SELF_UPDATE_TIME_UTC = '03:00'

/**
 * Parse CLI arguments into a structured result.
 *
 * @param {string[]} argv Arguments after the script name.
 * @returns {ParseResult}
 */
export function parseArgs(argv) {
  /** @type {string | undefined} */
  let configPath
  let printConfig = false
  let strict = false

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]

    if (arg === '--help' || arg === '-h') {
      return { mode: 'help' }
    }

    if (arg === '--version' || arg === '-V' || arg === '-v') {
      return { mode: 'version' }
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

    if (arg === '--strict') {
      strict = true
      continue
    }

    return parseError(`unknown argument: ${arg}`)
  }

  if (configPath === undefined) {
    return parseError('--config <path> is required')
  }

  return { mode: 'config', configPath, printConfig, strict }
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
 * @param {NodeJS.ProcessEnv} env Environment variables (read for upload credentials).
 * @param {{
 *   stdout?: { write: (s: string) => void },
 *   stderr?: { write: (s: string) => void },
 *   onShutdownRequested?: (handler: (signal: string) => void) => void,
 *   isTTY?: boolean,
 *   runInit?: () => Promise<number>,
 * }} [hooks]
 * @returns {Promise<number>}
 */
export async function run(argv, env, hooks = {}) {
  const stdout = hooks.stdout ?? process.stdout
  const stderr = hooks.stderr ?? process.stderr
  const onShutdownRequested = hooks.onShutdownRequested ?? defaultSignalWiring
  const isTTY = hooks.isTTY ?? Boolean(process.stdin.isTTY)

  // Bare `collectivus` on a real terminal launches the interactive walkthrough
  // that builds a config. Non-TTY (CI / piped stdin) keeps the existing
  // "--config required" error so scripts that depend on the exit code aren't
  // silently turned into a hung readline.
  if (argv.length === 0 && isTTY) {
    const runInitFn = hooks.runInit ?? (await import('./cli/init.js')).runInit
    return runInitFn()
  }

  const parsed = parseArgs(argv)

  if (parsed.mode === 'help') {
    stdout.write(USAGE + '\n')
    return 0
  }
  if (parsed.mode === 'version') {
    stdout.write(readPackageVersion() + '\n')
    return 0
  }
  if (parsed.mode === 'error') {
    stderr.write(`error: ${parsed.message}\n\n${USAGE}\n`)
    return parsed.exitCode
  }

  /** @type {CollectivusConfig} */
  let config
  try {
    config = await loadConfigAsync(parsed.configPath, { strict: parsed.strict, stderr })
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

  // Fail at boot rather than at the first daily uploader tick when the
  // upload section is configured but AWS credentials aren't in the env.
  if (config.upload && (!env?.AWS_ACCESS_KEY_ID || !env?.AWS_SECRET_ACCESS_KEY)) {
    stderr.write(
      'config error: upload.bucket is set but AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are not in the environment.\n'
    )
    return 1
  }

  return runLifecycle(buildConfigListeners(config, { env, stderr }), stdout, stderr, onShutdownRequested)
}

/**
 * @param {CollectivusConfig} config
 * @param {{ env?: NodeJS.ProcessEnv, stderr: { write: (s: string) => void } }} ctx
 *   `env` is forwarded to the uploader so its connector reads creds from the
 *   same env we pre-flighted in `run()`. `stderr` is consumed by the
 *   self-update factory for warning output.
 * @returns {ListenerFactory[]}
 */
function buildConfigListeners(config, ctx) {
  /** @type {ListenerFactory[]} */
  const factories = []

  if (config.otel) {
    if (!config.sink) {
      throw new Error('otel is configured but sink is missing')
    }
    const { listen } = config.otel
    const outputDir = config.sink.dir
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
        // Stop accepting new connections, drain any in-flight exchanges (their
        // finalization can be async — e.g. a gzip decoder still flushing the
        // tail of an SSE stream), then flush+close the sink so the final
        // `exchange` row lands before exit.
        stop: async () => {
          await proxy.stop()
          await recorder.drain()
          await sink.close()
        },
      }
    })
  }

  if (config.upload) {
    if (!config.sink) {
      throw new Error('upload is configured but sink is missing')
    }
    const uploadConfig = config.upload
    const sinkDir = config.sink.dir
    // Lazy import keeps the SigV4 / parquet code off the hot path for
    // installs that don't enable upload.
    factories.push(async () => {
      const { createUploader } = await import('./upload/index.js')
      const uploader = createUploader({
        outputDir: sinkDir,
        options: uploadConfig,
        env: ctx.env,
      })
      await uploader.start()
      const time = uploadConfig.time ?? '00:10'
      const prefix = uploadConfig.prefix ?? 'collectivus'
      return {
        description: `Uploader scheduled for ${time} UTC, target s3://${uploadConfig.bucket}/${prefix}`,
        stop: () => uploader.stop(),
      }
    })
  }

  // Only schedule the self-update tick when we have a real listener to keep
  // alive — an empty config should still surface "no listeners configured".
  if (factories.length > 0) {
    factories.push(buildSelfUpdateFactory(ctx))
  }

  return factories
}

/**
 * Build a listener factory for the daily self-update tick. The factory
 * starts a scheduler that runs once per UTC day at `SELF_UPDATE_TIME_UTC`;
 * each tick checks the npm registry and, if a newer version is published,
 * runs `npm install -g collectivus@<latest>` and (only when running under
 * a supervisor like launchd / systemd) sends SIGTERM so the supervisor
 * respawns the process on the new code.
 *
 * Robustness: the tick swallows everything so a failure never escalates
 * into the scheduler's fast-retry path — if anything goes wrong we just
 * wait until tomorrow's tick. The factory itself also swallows startup
 * errors and returns a no-op listener so a broken self-update path can
 * never take down the OTLP collector or proxy.
 *
 * @param {{ stderr: { write: (s: string) => void } }} ctx
 * @returns {ListenerFactory}
 */
function buildSelfUpdateFactory(ctx) {
  return async () => {
    try {
      const scheduler = createScheduler({
        time: SELF_UPDATE_TIME_UTC,
        skipInitialTick: true,
        tick: async () => {
          try {
            const installed = await selfUpdate()
            if (installed !== undefined && isSupervised()) {
              // Trigger graceful shutdown; supervisor will restart with new code.
              process.kill(process.pid, 'SIGTERM')
            }
          } catch (err) {
            ctx.stderr.write(`warning: self-update tick failed: ${formatError(err)}\n`)
          }
        },
      })
      await scheduler.start()
      return {
        description: `Self-update check scheduled daily at ${SELF_UPDATE_TIME_UTC} UTC`,
        stop: () => scheduler.stop(),
      }
    } catch (err) {
      ctx.stderr.write(`warning: self-update disabled (${formatError(err)})\n`)
      return {
        description: 'Self-update check disabled (failed to start)',
        stop: async () => {},
      }
    }
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
 * @param {Server | undefined} server
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
