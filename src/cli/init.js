import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { defaultPrompt } from './common.js'

/**
 * @import { CollectivusConfig, FileSinkConfig, InitHooks, OtelConfig, ProxyConfig, UploadConfig } from '../types.js'
 */

const PROVIDERS = [
  {
    id: 'anthropic',
    name: 'Anthropic Claude API',
    baseUrl: 'https://api.anthropic.com',
    prefix: '/v1/messages',
  },
  {
    id: 'openai',
    name: 'OpenAI API',
    baseUrl: 'https://api.openai.com',
    prefix: '/v1',
  },
  {
    id: 'gemini',
    name: 'Google Gemini API',
    baseUrl: 'https://generativelanguage.googleapis.com',
    prefix: '/v1',
  },
]

const DEFAULT_REDACT = [
  'authorization',
  'x-api-key',
  'anthropic-api-key',
  'cookie',
  'set-cookie',
]

const DEFAULT_PROXY_LISTEN = '127.0.0.1:8787'
const DEFAULT_OTEL_LISTEN = '0.0.0.0:4318'

const DEFAULT_UPLOAD_REGION = 'us-east-1'
const DEFAULT_UPLOAD_PREFIX = 'collectivus'
const DEFAULT_UPLOAD_TIME = '00:10'
/** @type {readonly import('../types.js').UploadSignal[]} */
const ALLOWED_UPLOAD_SIGNALS = ['logs', 'traces', 'metrics']
const DEFAULT_UPLOAD_SIGNALS_INPUT = ALLOWED_UPLOAD_SIGNALS.join(',')
// DNS-compatible bucket name: 3–63 chars, lowercase, no underscores. The
// inner `{1,61}` plus the leading and trailing single-character classes
// produce the 3..63 length bound.
const BUCKET_PATTERN = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/
const TIME_PATTERN = /^([01][0-9]|2[0-3]):[0-5][0-9]$/

const BANNER = [
  '        ╱────────╲',
  '      ╱────────────╲',
  '    ╱────────────────╲',
  '   ┌──────────────────┐',
  '   │   COLLECTIVUS    │',
  '   └──────────────────┘',
  '     ║  ║  ║  ║  ║  ║',
  '     ║  ║  ║  ║  ║  ║',
  '  ══════════════════════',
  ' ════════════════════════',
].join('\n') + '\n'

/**
 * `~/.hyp/collectivus.json` is the convention for collectivus config: it lives
 * alongside the daemon's log directory at `~/.hyp/collectivus/` and survives
 * `rm -rf` of the working directory the user happened to be in when they ran
 * the walkthrough.
 *
 * @param {string} [homeDir]
 * @returns {string}
 */
function defaultConfigPath(homeDir) {
  return path.join(homeDir ?? os.homedir(), '.hyp', 'collectivus.json')
}

/**
 * `~/.hyp/collectivus/` is the same tree the daemon writes logs into, so a
 * fresh install keeps everything (logs + recordings) rooted in a single
 * predictable directory. The collector creates per-signal subdirectories
 * inside it (`traces/<date>.jsonl`, `proxy.jsonl`, etc.).
 *
 * @param {string} [homeDir]
 * @returns {string}
 */
function defaultSinkDir(homeDir) {
  return path.join(homeDir ?? os.homedir(), '.hyp', 'collectivus')
}

/**
 * Run the no-arg interactive walkthrough. Asks what the user wants to set up,
 * builds a `CollectivusConfig`, writes it to disk, and (for proxy setups on
 * darwin/linux) chains into `runInstall` to install the daemon and optionally
 * attach Claude Code.
 *
 * If a config already exists at the default save path, summarizes it first and
 * offers the user the choice to reuse it (skipping straight to the daemon
 * install offer) or to start fresh.
 *
 * @param {InitHooks} [hooks]
 * @returns {Promise<number>}
 */
export async function runInit(hooks = {}) {
  const stdout = hooks.stdout ?? process.stdout
  const stderr = hooks.stderr ?? process.stderr
  const prompt = hooks.prompt ?? defaultPrompt
  const writeFile = hooks.writeFile ?? defaultWriteFile
  const readConfig = hooks.readConfig ?? defaultReadConfig
  const platform = hooks.platform ?? process.platform
  const cwd = hooks.cwd ?? process.cwd()
  const defaultCfgPath = hooks.defaultConfigPath ?? defaultConfigPath()

  stdout.write('\n' + BANNER + '\nWelcome to collectivus.\n')

  const existing = readConfig(defaultCfgPath)
  if (existing) {
    stdout.write(`\nFound an existing config at ${defaultCfgPath}:\n`)
    printConfigSummary(stdout, existing)
    const ans = (await prompt('\nUse this config, or create a new one? [use/new]: ')).trim()
    if (ans === '' || /^u(se)?$/i.test(ans) || /^y(es)?$/i.test(ans)) {
      return useExistingConfig({
        config: existing, configPath: defaultCfgPath,
        stdout, prompt, platform,
        runInstall: hooks.runInstall,
      })
    }
  }

  stdout.write('\nI\'ll ask a few questions and write a config for you.\n')

  stdout.write('\nWhat would you like collectivus to do?\n\n')
  stdout.write('  1) LLM gateway proxy\n')
  stdout.write('     Sits between your app and an LLM API (Anthropic, OpenAI, Gemini, or\n')
  stdout.write('     a custom endpoint) and records every request + response, including\n')
  stdout.write('     the full prompt, full model output, and SSE event stream. Highest-\n')
  stdout.write('     fidelity capture: you see exactly what your app sent and got back.\n')
  stdout.write('     You point your app at the proxy by setting its base URL.\n\n')
  stdout.write('  2) OTLP receiver\n')
  stdout.write('     Accepts OpenTelemetry traces, metrics, and logs over OTLP/HTTP and\n')
  stdout.write('     writes them to local JSONL. Captures structured spans (timing,\n')
  stdout.write('     attributes) and metrics — useful when your services already emit\n')
  stdout.write('     OTel — but it does NOT see raw LLM prompts or completions unless\n')
  stdout.write('     your app explicitly logs them as span attributes.\n\n')
  stdout.write('  3) Both — proxy and OTLP receiver in the same process.\n\n')
  stdout.write('If you are not sure: choose 1 to record LLM traffic; choose 2 if you\n')
  stdout.write('already have OTel-instrumented services.\n')
  let mode
  for (;;) {
    const modeRaw = (await prompt('Choose [1]: ')).trim()
    const candidate = modeRaw === '' ? '1' : modeRaw
    if (candidate === '1' || candidate === '2' || candidate === '3') {
      mode = candidate
      break
    }
    stderr.write(`error: please choose 1, 2, or 3 (got ${JSON.stringify(modeRaw)})\n`)
  }
  const wantProxy = mode === '1' || mode === '3'
  const wantOtel = mode === '2' || mode === '3'

  /** @type {CollectivusConfig} */
  const config = { version: 1 }

  if (wantProxy) {
    config.proxy = await askProxy(prompt, stdout, stderr)
  }

  if (wantOtel) {
    stdout.write('\nThe OTLP receiver will accept POSTs at /v1/traces, /v1/metrics,\n')
    stdout.write('and /v1/logs. Point your OTel SDKs / collector exporters at this\n')
    stdout.write('address. 0.0.0.0 listens on all interfaces; use 127.0.0.1 to keep\n')
    stdout.write('it strictly local.\n')
    const ans = (await prompt(`OTLP listen address [${DEFAULT_OTEL_LISTEN}]: `)).trim()
    /** @type {OtelConfig} */
    const otel = { listen: ans === '' ? DEFAULT_OTEL_LISTEN : ans }
    config.otel = otel
  }

  const defaultSink = hooks.defaultSinkDir ?? defaultSinkDir()
  stdout.write('\nWhere should collectivus write recordings? Each signal lands in its\n')
  stdout.write('own JSONL file under this directory (e.g. proxy.jsonl, traces/<date>.jsonl).\n')
  const sinkAns = (await prompt(`Sink directory [${defaultSink}]: `)).trim()
  /** @type {FileSinkConfig} */
  const sink = { type: 'file', dir: sinkAns === '' ? defaultSink : sinkAns }
  config.sink = sink

  const upload = await askUpload(prompt, stdout, stderr)
  if (upload) config.upload = upload

  const cfgPathAns = (await prompt(`Save config to [${defaultCfgPath}]: `)).trim()
  const cfgPath = cfgPathAns === '' ? defaultCfgPath : path.resolve(cwd, cfgPathAns)

  const json = JSON.stringify(config, null, 2)
  stdout.write('\n--- ' + cfgPath + ' ---\n')
  stdout.write(json + '\n')
  stdout.write('-'.repeat(cfgPath.length + 8) + '\n\n')

  const confirmAns = (await prompt(`Write this config to ${cfgPath}? [Y/n]: `)).trim()
  if (!isYes(confirmAns)) {
    stdout.write('Aborted. No changes made.\n')
    return 0
  }
  try {
    writeFile(cfgPath, json + '\n')
    stdout.write(`✓ Wrote ${cfgPath}\n`)
    if (config.upload) {
      stdout.write('ⓘ Upload requires AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY in env.\n')
      stdout.write('  Daemon will fail fast at start if they are missing.\n')
    }
  } catch (err) {
    stderr.write(`error: failed to write config: ${formatError(err)}\n`)
    return 1
  }

  return offerDaemonInstall({
    configPath: cfgPath, wantProxy,
    stdout, prompt, platform,
    runInstall: hooks.runInstall,
  })
}

/**
 * Prompt for daemon install + Claude Code attach when the platform supports it
 * and the config has a proxy listener. Otherwise prints next-step hints.
 *
 * @param {{
 *   configPath: string,
 *   wantProxy: boolean,
 *   stdout: { write: (s: string) => void },
 *   prompt: (q: string) => Promise<string>,
 *   platform: NodeJS.Platform,
 *   runInstall?: (args: string[]) => Promise<number>,
 * }} args
 * @returns {Promise<number>}
 */
async function offerDaemonInstall(args) {
  const { configPath, wantProxy, stdout, prompt, platform } = args
  if (wantProxy && (platform === 'darwin' || platform === 'linux')) {
    const daemonKind = platform === 'darwin' ? 'launchd LaunchAgent' : 'systemd user unit'
    stdout.write('\nRun collectivus as a background daemon?\n')
    stdout.write(`  Yes → installs a ${daemonKind} that starts at login and respawns\n`)
    stdout.write('        if it crashes. Logs go to ~/.hyp/collectivus/. Reversible\n')
    stdout.write('        with `collectivus uninstall`.\n')
    stdout.write('  No  → only runs while you launch it manually with\n')
    stdout.write('        `collectivus --config <path>` in a terminal.\n')
    const dAns = (await prompt('Install as background daemon? [Y/n]: ')).trim()
    if (isYes(dAns)) {
      stdout.write('\nConfigure Claude Code to route through this proxy?\n')
      stdout.write('  Yes → adds ANTHROPIC_BASE_URL=http://127.0.0.1:<port> to\n')
      stdout.write('        ~/.claude/settings.json so the `claude` CLI uses the proxy.\n')
      stdout.write('        Reversible with `collectivus detach`.\n')
      stdout.write('  No  → leaves Claude Code untouched; attach later with\n')
      stdout.write('        `collectivus attach`.\n')
      const cAns = (await prompt('Configure Claude Code? [Y/n]: ')).trim()
      const installArgs = ['--config', configPath, isYes(cAns) ? '--yes' : '--no']
      const runInstallFn = args.runInstall ?? await loadRunInstall()
      return runInstallFn(installArgs)
    }
  }

  stdout.write('\nNext steps:\n')
  stdout.write(`  collectivus --config ${configPath}\n`)
  if (wantProxy && (platform === 'darwin' || platform === 'linux')) {
    stdout.write(`  collectivus install --config ${configPath}   (run as a background daemon)\n`)
  }
  return 0
}

/**
 * Reuse-existing branch: the user accepted the config we found at the default
 * path. Skip the question flow and jump to the daemon install offer (or hint
 * when the platform / config doesn't qualify).
 *
 * @param {{
 *   config: CollectivusConfig,
 *   configPath: string,
 *   stdout: { write: (s: string) => void },
 *   prompt: (q: string) => Promise<string>,
 *   platform: NodeJS.Platform,
 *   runInstall?: (args: string[]) => Promise<number>,
 * }} args
 * @returns {Promise<number>}
 */
function useExistingConfig(args) {
  const wantProxy = args.config.proxy !== undefined
  return offerDaemonInstall({
    configPath: args.configPath, wantProxy,
    stdout: args.stdout, prompt: args.prompt, platform: args.platform,
    runInstall: args.runInstall,
  })
}

/**
 * Print a short, human-readable summary of an existing config so the user can
 * decide whether to reuse it. Intentionally not the full JSON dump — that's
 * what `--print-config` is for.
 *
 * @param {{ write: (s: string) => void }} stdout
 * @param {CollectivusConfig} config
 */
function printConfigSummary(stdout, config) {
  if (config.proxy) {
    const upstreams = config.proxy.upstreams ?? []
    const detail = upstreams
      .map(function(u) {
        const prefix = u?.match?.path_prefix ?? ''
        return `${u?.name ?? ''} → ${u?.base_url ?? ''}${prefix}`
      })
      .join(', ')
    stdout.write(`  proxy:  ${config.proxy.listen}${detail ? `  (${detail})` : ''}\n`)
  }
  if (config.otel) {
    stdout.write(`  otel:   ${config.otel.listen}\n`)
  }
  if (config.sink) {
    stdout.write(`  sink:   ${config.sink.dir}\n`)
  }
  if (config.upload) {
    const u = config.upload
    const prefix = u.prefix ?? DEFAULT_UPLOAD_PREFIX
    const time = u.time ?? DEFAULT_UPLOAD_TIME
    stdout.write(`  upload: s3://${u.bucket}/${prefix} daily at ${time} UTC\n`)
  }
}

/**
 * Read and parse a config file. Returns undefined when the file is missing or
 * unparseable — the walkthrough treats both as "no usable existing config" and
 * falls through to the question flow.
 *
 * @param {string} p
 * @returns {CollectivusConfig | undefined}
 */
function defaultReadConfig(p) {
  let raw
  try {
    raw = fs.readFileSync(p, 'utf8')
  } catch {
    return
  }
  try {
    return JSON.parse(raw)
  } catch { /* ignore — fall through to undefined */ }
}

/**
 * @param {(q: string) => Promise<string>} prompt
 * @param {{ write: (s: string) => void }} stdout
 * @param {{ write: (s: string) => void }} stderr
 * @returns {Promise<ProxyConfig>}
 */
async function askProxy(prompt, stdout, stderr) {
  stdout.write('\nWhich LLM provider should the proxy forward to?\n')
  stdout.write('Pick the upstream API you want to record against. The proxy will\n')
  stdout.write('listen locally and forward every matching request to this base URL,\n')
  stdout.write('writing the full request + response (and SSE events for streaming)\n')
  stdout.write('to your sink directory.\n\n')
  PROVIDERS.forEach(function(p, i) {
    stdout.write(`  ${i + 1}) ${p.name.padEnd(22)} → ${p.baseUrl}${p.prefix}\n`)
  })
  stdout.write(`  ${PROVIDERS.length + 1}) ${'Custom'.padEnd(22)} → enter your own base URL + path prefix\n`)
  /** @type {string} */
  let baseUrl
  /** @type {string} */
  let prefix
  /** @type {string} */
  let upstreamName

  for (;;) {
    const provRaw = (await prompt('Provider [1]: ')).trim()
    const provIdx = provRaw === '' ? 1 : Number.parseInt(provRaw, 10)

    if (Number.isInteger(provIdx) && provIdx >= 1 && provIdx <= PROVIDERS.length) {
      const p = PROVIDERS[provIdx - 1]
      baseUrl = p.baseUrl
      prefix = p.prefix
      upstreamName = p.id
      break
    }
    if (provIdx === PROVIDERS.length + 1) {
      let url = ''
      while (url === '') {
        url = (await prompt('Upstream base URL (e.g. https://api.example.com): ')).trim()
        if (url === '') stderr.write('error: base URL is required\n')
      }
      baseUrl = url
      const prefAns = (await prompt('Path prefix to match [/v1]: ')).trim()
      prefix = prefAns === '' ? '/v1' : prefAns
      const derivedName = deriveUpstreamName(baseUrl)
      stdout.write('\nName for this upstream — appears in recorded rows and logs.\n')
      stdout.write('Slug: lowercase letters, digits, hyphens; must start with a letter.\n')
      let nameValid = false
      while (!nameValid) {
        const nameAns = (await prompt(`Upstream name [${derivedName}]: `)).trim()
        if (nameAns === '') {
          upstreamName = derivedName
          nameValid = true
        } else if (!isValidUpstreamSlug(nameAns)) {
          stderr.write(
            `error: name must match [a-z][a-z0-9-]* (got ${JSON.stringify(nameAns)})\n`
          )
        } else {
          upstreamName = nameAns
          nameValid = true
        }
      }
      break
    }
    stderr.write(`error: invalid provider choice ${JSON.stringify(provRaw)}\n`)
  }

  stdout.write('\nWhere should the proxy listen? This is the local address your app\n')
  stdout.write('will point at instead of the upstream API. 127.0.0.1 keeps it local\n')
  stdout.write('to this machine; use 0.0.0.0 to expose it on your network.\n')
  const listenAns = (await prompt(`Proxy listen address [${DEFAULT_PROXY_LISTEN}]: `)).trim()
  const listen = listenAns === '' ? DEFAULT_PROXY_LISTEN : listenAns

  /** @type {ProxyConfig} */
  return {
    listen,
    upstreams: [
      {
        name: upstreamName,
        base_url: baseUrl,
        match: { path_prefix: prefix },
      },
    ],
    redact_headers: DEFAULT_REDACT,
  }
}

/**
 * Optional S3 upload step. Asks `[y/N]` first; on `y` collects bucket /
 * region / prefix / time / signals / endpoint with re-prompt loops on
 * validation failure. Returns `undefined` when the user declines, so the
 * caller can omit the `upload` block entirely.
 *
 * The walkthrough deliberately does not expose `catchupDays` (defaults to
 * 30 in the uploader) — keeps the prompt count manageable. Power users
 * edit the JSON.
 *
 * Credentials are never collected here; the daemon resolves them from
 * environment variables at startup.
 *
 * @param {(q: string) => Promise<string>} prompt
 * @param {{ write: (s: string) => void }} stdout
 * @param {{ write: (s: string) => void }} stderr
 * @returns {Promise<UploadConfig | undefined>}
 */
async function askUpload(prompt, stdout, stderr) {
  const ans = (await prompt('\nUpload daily snapshots to S3 as Parquet? [y/N]: ')).trim()
  if (!/^y(es)?$/i.test(ans)) return undefined

  stdout.write('\nLocal JSONL stays put; once a day collectivus drains the previous day\'s\n')
  stdout.write('files to your S3 bucket as Parquet partitions. Useful for long-term\n')
  stdout.write('retention and querying with Athena / DuckDB.\n\n')

  /** @type {string} */
  let bucket
  for (;;) {
    const a = (await prompt('  S3 bucket: ')).trim()
    if (a !== '' && BUCKET_PATTERN.test(a)) { bucket = a; break }
    stderr.write('  bucket name must be 3–63 chars, lowercase, no underscores\n')
  }

  const regionAns = (await prompt(`  S3 region [${DEFAULT_UPLOAD_REGION}]: `)).trim()
  const region = regionAns === '' ? DEFAULT_UPLOAD_REGION : regionAns

  const prefixAns = (await prompt(`  Object prefix [${DEFAULT_UPLOAD_PREFIX}]: `)).trim()
  // Strip surrounding `/` so the user pasting `/foo/` gets the same key
  // layout as a clean `foo`. An input of just `/` collapses to empty,
  // which falls back to the default rather than emitting an empty
  // string (the validator rejects that).
  const trimmedPrefix = prefixAns.replace(/^\/+|\/+$/g, '')
  const prefix = trimmedPrefix === '' ? DEFAULT_UPLOAD_PREFIX : trimmedPrefix

  /** @type {string} */
  let time
  for (;;) {
    const a = (await prompt(`  Daily upload time UTC [${DEFAULT_UPLOAD_TIME}]: `)).trim()
    const v = a === '' ? DEFAULT_UPLOAD_TIME : a
    if (TIME_PATTERN.test(v)) { time = v; break }
    stderr.write('  time must be HH:MM (24-hour, 00:00–23:59)\n')
  }

  /** @type {import('../types.js').UploadSignal[]} */
  let signals
  for (;;) {
    const a = (await prompt(`  Signals to upload [${DEFAULT_UPLOAD_SIGNALS_INPUT}]: `)).trim()
    const raw = a === '' ? DEFAULT_UPLOAD_SIGNALS_INPUT : a
    const list = raw.split(',').map(function(s) { return s.trim() }).filter(function(s) { return s !== '' })
    /** @type {import('../types.js').UploadSignal[]} */
    const narrowed = []
    let bad = false
    for (const s of list) {
      const matched = ALLOWED_UPLOAD_SIGNALS.find(function(allowed) { return allowed === s })
      if (matched === undefined) { bad = true; break }
      narrowed.push(matched)
    }
    if (!bad && narrowed.length > 0) { signals = narrowed; break }
    stderr.write('  signals must be a comma-separated subset of: logs, traces, metrics\n')
  }

  /** @type {string | undefined} */
  let endpoint
  for (;;) {
    const a = (await prompt('  Custom S3 endpoint (MinIO etc.) []: ')).trim()
    if (a === '') { endpoint = undefined; break }
    try {
      new URL(a)
      endpoint = a
      break
    } catch {
      stderr.write('  endpoint must be a valid URL (e.g. https://minio.example.com)\n')
    }
  }

  stdout.write('\nNote: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_REGION must be\n')
  stdout.write('set when the daemon runs. The walkthrough will not store credentials\n')
  stdout.write('in the config file.\n')

  /** @type {UploadConfig} */
  const upload = { bucket, region, prefix, time, signals }
  if (endpoint !== undefined) upload.endpoint = endpoint
  return upload
}

/**
 * @returns {Promise<(args: string[]) => Promise<number>>}
 */
async function loadRunInstall() {
  const mod = await import('./install.js')
  return function(args) { return mod.runInstall(args) }
}

/**
 * @param {string} p
 * @param {string} contents
 */
function defaultWriteFile(p, contents) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, contents)
}

/**
 * Empty input is treated as "yes" so users can press Enter to accept the
 * default in `[Y/n]` prompts.
 *
 * @param {string} s
 * @returns {boolean}
 */
function isYes(s) {
  if (s === '') return true
  return /^y(es)?$/i.test(s)
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}

const UPSTREAM_SLUG_PATTERN = /^[a-z][a-z0-9-]*$/

/**
 * @param {string} s
 * @returns {boolean}
 */
function isValidUpstreamSlug(s) {
  return UPSTREAM_SLUG_PATTERN.test(s)
}

/**
 * Derive a default upstream name from a base URL. Strips `api.` / `www.`
 * prefixes and takes the first remaining hostname label, lowercased and
 * stripped of slug-incompatible characters. Falls back to `upstream` when the
 * URL doesn't parse, the hostname is bare-IP, or the derived label doesn't
 * start with a letter.
 *
 * @param {string} baseUrl
 * @returns {string}
 */
function deriveUpstreamName(baseUrl) {
  let host
  try {
    host = new URL(baseUrl).hostname
  } catch {
    return 'upstream'
  }
  if (!host) return 'upstream'
  const stripped = host.replace(/^(api|www)\./, '')
  const label = stripped.split('.')[0] ?? ''
  const slug = label.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '')
  return isValidUpstreamSlug(slug) ? slug : 'upstream'
}
