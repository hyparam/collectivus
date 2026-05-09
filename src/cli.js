import process from 'node:process'
import { readPackageVersion } from './cli/common.js'
import { Collector } from './collector.js'
import { ConfigError, loadConfig } from './config.js'
import { ConfigClient } from './gateway/config_client.js'
import { IdentityClient } from './gateway/identity.js'
import { Proxy } from './proxy.js'
import { Recorder } from './recorder.js'
import { ControlPlane } from './server/control_plane.js'
import { FileSink } from './sinks/file.js'
import { isSupervised, selfUpdate } from './update.js'
import { createScheduler } from './upload/scheduler.js'

/**
 * @import { Server } from 'node:http'
 * @import { ErrorResult, ParseResult, StartedListener, ListenerFactory, CollectivusConfig } from './types.js'
 */

const USAGE = `Usage:
  collectivus --config <path>                  Run with config file
  collectivus --config <path> --print-config   Load config, print resolved JSON, exit
  collectivus --config <path> --strict         Reject unknown top-level config keys
  collectivus --help                           Show this help
  collectivus --version                        Print program version

Subcommands:
  collectivus install [--config <path>] [--yes|--no]   Install the launch agent
  collectivus uninstall [--detach]                     Remove the launch agent
  collectivus attach   --config <path>                 Attach Claude Code settings
  collectivus detach                                   Revert Claude Code settings
  collectivus status                                   Show install + attach state
  collectivus config <set|get|list|delete|bootstrap-token> ...
                                                       Operator CLI for per-gateway configs

Run \`collectivus <subcommand> --help\` for subcommand-specific options.`

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
    config = loadConfig(parsed.configPath, { strict: parsed.strict, stderr })
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

  // role: gateway must hold a valid JWT before any listener binds. Acquire
  // here (eager, before runLifecycle) so a bad bootstrap token or unreachable
  // central server fails with a clean stderr line and exit 1, without ever
  // opening a port. The IdentityClient is then handed to buildConfigListeners
  // for future epics (B config vending, C log shipping) to consume.
  /** @type {IdentityClient | undefined} */
  let identityClient
  /** @type {ConfigClient | undefined} */
  let configClient
  if (config.role === 'gateway') {
    if (!config.central_server) {
      stderr.write('config error: role: gateway requires a central_server block (validator should have caught this).\n')
      return 1
    }
    identityClient = new IdentityClient(config.central_server)
    try {
      const source = await identityClient.acquire()
      const id = identityClient.identity
      stdout.write(`Identity ${source} for ${id ? id.gateway_id : 'gateway'}\n`)
    } catch (err) {
      stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`)
      return 1
    }
    // ConfigClient runs in the background. It is a normal listener — wired
    // into stopAll via buildConfigListeners — so a SIGTERM stops the poll
    // timer the same way it stops the proxy. Construct here (after identity
    // has succeeded) rather than inside the factory so it's available to
    // any future listener that wants to subscribe to `config-changed`.
    configClient = new ConfigClient(config.central_server, identityClient, { stderr })
  }

  return runLifecycle(
    buildConfigListeners(config, { env, stderr, identityClient, configClient }),
    stdout,
    stderr,
    onShutdownRequested
  )
}

/**
 * @param {CollectivusConfig} config
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   stderr: { write: (s: string) => void },
 *   identityClient?: IdentityClient,
 *   configClient?: ConfigClient,
 * }} ctx
 *   `env` is forwarded to the uploader so its connector reads creds from the
 *   same env we pre-flighted in `run()`. `stderr` is consumed by the
 *   self-update factory for warning output. `identityClient` is set when
 *   `config.role === 'gateway'` and `run()` has already acquired the JWT;
 *   future epics (B config vending, C log shipping) will read this off `ctx`
 *   to authenticate to the central server. `configClient` is the gateway's
 *   background config-pull loop; B.4 will subscribe to its `config-changed`
 *   event for hot reload.
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
    const isServerDrain = config.role === 'server'
    if (!isServerDrain && !config.sink) {
      throw new Error('upload is configured but sink is missing')
    }
    if (isServerDrain && !config.server) {
      // The validator should have caught this; treat as a wiring bug.
      throw new Error('role: server requires server block')
    }
    const uploadConfig = config.upload
    const standaloneSinkDir = config.sink?.dir
    const serverSinkDirOverride = isServerDrain ? config.server?.sink_dir : undefined
    // Lazy import keeps the SigV4 / parquet code off the hot path for
    // installs that don't enable upload.
    factories.push(async () => {
      const { createUploader } = await import('./upload/index.js')
      /** @type {string} */
      let outputDir
      /** @type {ReadonlyArray<string> | undefined} */
      let partitionDimensions
      if (isServerDrain) {
        // Server-mode drain reads from the multi-tenant ingest spool
        // (`<sink_dir>/<gateway_id>/<signal>/<date>.jsonl`) written by
        // src/server/ingest.js, so the partition layout matches what the
        // ingest endpoint wrote — including no `service` directory level.
        const { defaultSinkDir } = await import('./server/ingest.js')
        outputDir = serverSinkDirOverride ?? defaultSinkDir()
        partitionDimensions = ['gateway_id', 'signal']
      } else {
        outputDir = /** @type {string} */ (standaloneSinkDir)
      }
      const uploader = createUploader({
        outputDir,
        options: { ...uploadConfig, partitionDimensions },
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

  // role: server brings up the control-plane HTTP listener (identity,
  // future config-vending, future log ingest). Only `server` triggers it —
  // `gateway` is a client of this listener and `standalone` doesn't use it.
  // The validator guarantees `config.server` is set iff role === 'server'.
  if (config.role === 'server') {
    const serverConfig = config.server
    if (!serverConfig) {
      throw new Error('role: server requires server block (validator should have caught this)')
    }
    factories.push(async () => {
      const controlPlane = new ControlPlane(serverConfig)
      await controlPlane.start()
      const effective = effectiveBinding(controlPlane.server, controlPlane.host, controlPlane.port)
      return {
        description: `Control-plane listener bound on ${effective}`,
        stop: () => controlPlane.stop(),
      }
    })
  }

  // Background config-pull loop runs alongside the proxy/otel listeners on
  // gateways. We register it here so its lifetime is tied to the same
  // start/stop machinery — a SIGTERM stops the timer cleanly without leaving
  // an orphaned setTimeout in the event loop. B.4 will subscribe to
  // `config-changed` for hot reload; for now the event simply fires and is
  // observed in tests.
  if (config.role === 'gateway' && ctx.configClient) {
    const configClient = ctx.configClient
    const url = config.central_server?.url ?? 'central server'
    const poll = configClient.pollIntervalSeconds
    factories.push(async () => {
      configClient.start()
      return {
        description: `Config poll loop active (${url} every ${poll}s)`,
        stop: async () => {
          configClient.stop()
          await configClient.whenIdle()
        },
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
