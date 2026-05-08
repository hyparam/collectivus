import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { defaultPrompt, isNpxBinPath } from './common.js'

/**
 * @import { CollectivusConfig, InitHooks, OtelConfig, ProxyConfig, UploadConfig } from '../types.js'
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

const SINGLE_PROXY_LISTEN = '127.0.0.1:8787'
const ENTERPRISE_PROXY_LISTEN = '0.0.0.0:8787'
const ENTERPRISE_OTEL_LISTEN = '0.0.0.0:4318'

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

const UPSTREAM_SLUG_PATTERN = /^[a-z][a-z0-9-]*$/

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
 * Run the no-arg interactive walkthrough. Top-level question is single-user
 * vs. enterprise (central server). Each branch asks just the questions it
 * needs, builds a v1 `CollectivusConfig`, writes it to disk, and (for proxy
 * setups on darwin/linux) chains into `runInstall` to install the daemon and
 * optionally attach Claude Code. The enterprise branch also prints the
 * `npx collectivus --config <url>` command team members run on their own
 * machines to point at the server.
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
  const binPath = hooks.binPath ?? process.argv[1] ?? ''
  const defaultCfgPath = hooks.defaultConfigPath ?? defaultConfigPath()
  const defaultSink = hooks.defaultSinkDir ?? defaultSinkDir()

  stdout.write('\n' + BANNER + '\nWelcome to collectivus.\n')

  const existing = readConfig(defaultCfgPath)
  if (existing) {
    stdout.write(`\nFound an existing config at ${defaultCfgPath}:\n`)
    printConfigSummary(stdout, existing)
    stdout.write('\n  1) Use existing config\n')
    stdout.write('  2) Create a new one\n\n')
    /** @type {'use' | 'new'} */
    let choice
    for (;;) {
      const raw = (await prompt('Choose [1]: ')).trim()
      const c = raw === '' ? '1' : raw
      if (c === '1') { choice = 'use'; break }
      if (c === '2') { choice = 'new'; break }
      stderr.write(`error: please choose 1 or 2 (got ${JSON.stringify(raw)})\n`)
    }
    if (choice === 'use') {
      return useExistingConfig({
        config: existing, configPath: defaultCfgPath,
        stdout, prompt, platform, binPath,
        runInstall: hooks.runInstall,
      })
    }
  }

  stdout.write('\nHow will you use collectivus?\n\n')
  stdout.write('  1) Single-user (local)\n')
  stdout.write('     Run on this machine only. The proxy listens on localhost and\n')
  stdout.write('     recordings stay on disk here. Best for personal dev work.\n\n')
  stdout.write('  2) Enterprise (central server)\n')
  stdout.write('     Set this machine up as a central collectivus server. Team\n')
  stdout.write('     members run a one-line install on their own machines to point\n')
  stdout.write('     LLM traffic and OTel telemetry here for centralized recording.\n')
  stdout.write('     We\'ll print that install command at the end of this flow.\n\n')

  /** @type {'single' | 'enterprise'} */
  let kind
  for (;;) {
    const raw = (await prompt('Choose [1]: ')).trim()
    const c = raw === '' ? '1' : raw
    if (c === '1') { kind = 'single'; break }
    if (c === '2') { kind = 'enterprise'; break }
    stderr.write(`error: please choose 1 or 2 (got ${JSON.stringify(raw)})\n`)
  }

  if (kind === 'single') {
    return runSingleUserFlow({
      stdout, stderr, prompt, writeFile, platform, binPath, cwd,
      defaultCfgPath, defaultSink, runInstall: hooks.runInstall,
    })
  }
  return runEnterpriseFlow({
    stdout, stderr, prompt, writeFile, platform, binPath, cwd,
    defaultCfgPath, defaultSink, runInstall: hooks.runInstall,
  })
}

/**
 * Minimal single-user walkthrough. Defaults the proxy to 127.0.0.1:8787
 * forwarding to Anthropic and asks only where to keep recordings and where
 * to save the config. Users wanting a different upstream, an OTLP receiver,
 * or S3 upload edit the config (or re-run init and choose enterprise mode).
 *
 * @param {{
 *   stdout: { write: (s: string) => void },
 *   stderr: { write: (s: string) => void },
 *   prompt: (q: string) => Promise<string>,
 *   writeFile: (path: string, contents: string) => void,
 *   platform: NodeJS.Platform,
 *   binPath: string,
 *   cwd: string,
 *   defaultCfgPath: string,
 *   defaultSink: string,
 *   runInstall?: (args: string[]) => Promise<number>,
 * }} args
 * @returns {Promise<number>}
 */
async function runSingleUserFlow(args) {
  const { stdout, stderr, prompt, writeFile, platform, binPath, cwd, defaultCfgPath, defaultSink } = args

  stdout.write('\nSingle-user mode. The proxy will listen on 127.0.0.1:8787 and\n')
  stdout.write('forward LLM traffic to Anthropic. Edit the config later to switch\n')
  stdout.write('upstreams or add the OTLP receiver.\n\n')

  stdout.write('Where should collectivus write recordings? Each signal lands in its\n')
  stdout.write('own JSONL file under this directory (e.g. proxy.jsonl).\n')
  const sinkAns = (await prompt(`Sink directory [${defaultSink}]: `)).trim()
  const sinkDir = sinkAns === '' ? defaultSink : sinkAns

  const cfgPathAns = (await prompt(`Save config to [${defaultCfgPath}]: `)).trim()
  const cfgPath = cfgPathAns === '' ? defaultCfgPath : path.resolve(cwd, cfgPathAns)

  const provider = PROVIDERS[0]
  /** @type {CollectivusConfig} */
  const config = {
    version: 1,
    proxy: {
      listen: SINGLE_PROXY_LISTEN,
      upstreams: [
        {
          name: provider.id,
          base_url: provider.baseUrl,
          match: { path_prefix: provider.prefix },
        },
      ],
      redact_headers: DEFAULT_REDACT,
    },
    sink: { type: 'file', dir: sinkDir },
  }

  const written = await confirmAndWrite({ stdout, stderr, prompt, writeFile, config, cfgPath })
  if (!written) return 0

  return offerDaemonInstall({
    configPath: cfgPath, wantProxy: true,
    stdout, prompt, platform, binPath,
    runInstall: args.runInstall,
    offerClaudeCode: true,
  })
}

/**
 * Enterprise (central server) walkthrough. Asks for the public host the
 * server will be reachable at (used to print the client install command),
 * which LLM upstream to forward to, the listen addresses for the proxy and
 * OTLP receiver, the sink directory, optional S3 upload, and the config save
 * path.
 *
 * Ends by printing an ASCII-boxed `npx collectivus --config <url>` line that
 * team members run on their own machines.
 *
 * @param {{
 *   stdout: { write: (s: string) => void },
 *   stderr: { write: (s: string) => void },
 *   prompt: (q: string) => Promise<string>,
 *   writeFile: (path: string, contents: string) => void,
 *   platform: NodeJS.Platform,
 *   binPath: string,
 *   cwd: string,
 *   defaultCfgPath: string,
 *   defaultSink: string,
 *   runInstall?: (args: string[]) => Promise<number>,
 * }} args
 * @returns {Promise<number>}
 */
async function runEnterpriseFlow(args) {
  const { stdout, stderr, prompt, writeFile, platform, binPath, cwd, defaultCfgPath, defaultSink } = args

  stdout.write('\nEnterprise mode — setting up this machine as the central server.\n')

  stdout.write('\nPublic host or URL clients will reach this server at. Used to\n')
  stdout.write('build the install command for team members. Examples:\n')
  stdout.write('  https://collectivus.acme.internal\n')
  stdout.write('  collectivus.acme.com:8787\n')
  /** @type {string} */
  let publicHost
  for (;;) {
    const ans = (await prompt('Public host: ')).trim()
    if (ans !== '') { publicHost = ans; break }
    stderr.write('error: public host is required\n')
  }
  const publicUrl = normalizePublicUrl(publicHost)

  const upstream = await askProvider(prompt, stdout, stderr)

  stdout.write('\nRun the OTLP receiver alongside the proxy? It accepts OpenTelemetry\n')
  stdout.write('traces, metrics, and logs over OTLP/HTTP.\n')
  const otelAns = (await prompt('Enable OTLP receiver? [Y/n]: ')).trim()
  /** @type {OtelConfig | undefined} */
  let otel
  if (isYes(otelAns)) {
    const otelListenAns = (await prompt(`OTLP listen [${ENTERPRISE_OTEL_LISTEN}]: `)).trim()
    otel = { listen: otelListenAns === '' ? ENTERPRISE_OTEL_LISTEN : otelListenAns }
  }

  stdout.write('\nWhere should the server write recordings? Each signal lands in its\n')
  stdout.write('own JSONL file under this directory (e.g. proxy.jsonl, traces/<date>.jsonl).\n')
  const sinkAns = (await prompt(`Sink directory [${defaultSink}]: `)).trim()
  const sinkDir = sinkAns === '' ? defaultSink : sinkAns

  const upload = await askUpload(prompt, stdout, stderr)

  const cfgPathAns = (await prompt(`Save config to [${defaultCfgPath}]: `)).trim()
  const cfgPath = cfgPathAns === '' ? defaultCfgPath : path.resolve(cwd, cfgPathAns)

  /** @type {CollectivusConfig} */
  const config = {
    version: 1,
    proxy: {
      listen: ENTERPRISE_PROXY_LISTEN,
      upstreams: [
        {
          name: upstream.name,
          base_url: upstream.baseUrl,
          match: { path_prefix: upstream.prefix },
        },
      ],
      redact_headers: DEFAULT_REDACT,
    },
    sink: { type: 'file', dir: sinkDir },
  }
  if (otel) config.otel = otel
  if (upload) config.upload = upload

  const written = await confirmAndWrite({ stdout, stderr, prompt, writeFile, config, cfgPath })
  if (!written) return 0

  printClientInstallBox(stdout, publicUrl)

  return offerDaemonInstall({
    configPath: cfgPath, wantProxy: true,
    stdout, prompt, platform, binPath,
    runInstall: args.runInstall,
    offerClaudeCode: false,
  })
}

/**
 * Render the config preview, ask the user to confirm, and write the file.
 * Returns true if the file was written, false if the user aborted.
 *
 * @param {{
 *   stdout: { write: (s: string) => void },
 *   stderr: { write: (s: string) => void },
 *   prompt: (q: string) => Promise<string>,
 *   writeFile: (path: string, contents: string) => void,
 *   config: CollectivusConfig,
 *   cfgPath: string,
 * }} args
 * @returns {Promise<boolean>}
 */
async function confirmAndWrite(args) {
  const { stdout, stderr, prompt, writeFile, config, cfgPath } = args
  const json = JSON.stringify(config, null, 2)
  stdout.write('\n--- ' + cfgPath + ' ---\n')
  stdout.write(json + '\n')
  stdout.write('-'.repeat(cfgPath.length + 8) + '\n\n')

  const confirmAns = (await prompt(`Write this config to ${cfgPath}? [Y/n]: `)).trim()
  if (!isYes(confirmAns)) {
    stdout.write('Aborted. No changes made.\n')
    return false
  }
  try {
    writeFile(cfgPath, json + '\n')
    stdout.write(`✓ Wrote ${cfgPath}\n`)
    if (config.upload) {
      stdout.write('ⓘ Upload requires AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY in env.\n')
      stdout.write('  Daemon will fail fast at start if they are missing.\n')
    }
    return true
  } catch (err) {
    stderr.write(`error: failed to write config: ${formatError(err)}\n`)
    return false
  }
}

/**
 * Prompt the user to pick an LLM provider (or supply a custom upstream).
 * Returns a `{ name, baseUrl, prefix }` triple suitable for slotting into the
 * `proxy.upstreams` array.
 *
 * For custom upstreams, derives a default name slug from the base URL and
 * lets the user override it (validated against `[a-z][a-z0-9-]*`).
 *
 * @param {(q: string) => Promise<string>} prompt
 * @param {{ write: (s: string) => void }} stdout
 * @param {{ write: (s: string) => void }} stderr
 * @returns {Promise<{ name: string, baseUrl: string, prefix: string }>}
 */
async function askProvider(prompt, stdout, stderr) {
  stdout.write('\nWhich LLM provider should the proxy forward to?\n')
  PROVIDERS.forEach(function(p, i) {
    stdout.write(`  ${i + 1}) ${p.name.padEnd(22)} → ${p.baseUrl}${p.prefix}\n`)
  })
  stdout.write(`  ${PROVIDERS.length + 1}) ${'Custom'.padEnd(22)} → enter your own base URL + path prefix\n`)

  for (;;) {
    const provRaw = (await prompt('Provider [1]: ')).trim()
    const provIdx = provRaw === '' ? 1 : Number.parseInt(provRaw, 10)

    if (Number.isInteger(provIdx) && provIdx >= 1 && provIdx <= PROVIDERS.length) {
      const p = PROVIDERS[provIdx - 1]
      return { name: p.id, baseUrl: p.baseUrl, prefix: p.prefix }
    }
    if (provIdx === PROVIDERS.length + 1) {
      let baseUrl = ''
      while (baseUrl === '') {
        baseUrl = (await prompt('Upstream base URL (e.g. https://api.example.com): ')).trim()
        if (baseUrl === '') stderr.write('error: base URL is required\n')
      }
      const prefAns = (await prompt('Path prefix to match [/v1]: ')).trim()
      const prefix = prefAns === '' ? '/v1' : prefAns
      const derivedName = deriveUpstreamName(baseUrl)
      stdout.write('\nName for this upstream — appears in recorded rows and logs.\n')
      stdout.write('Slug: lowercase letters, digits, hyphens; must start with a letter.\n')
      for (;;) {
        const nameAns = (await prompt(`Upstream name [${derivedName}]: `)).trim()
        if (nameAns === '') return { name: derivedName, baseUrl, prefix }
        if (isValidUpstreamSlug(nameAns)) return { name: nameAns, baseUrl, prefix }
        stderr.write(`error: name must match [a-z][a-z0-9-]* (got ${JSON.stringify(nameAns)})\n`)
      }
    }
    stderr.write(`error: invalid provider choice ${JSON.stringify(provRaw)}\n`)
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
 * Normalize a user-supplied public host into a fully-qualified URL with no
 * trailing slash. Bare hostnames get an `https://` scheme prepended; existing
 * schemes are preserved.
 *
 * @param {string} input
 * @returns {string}
 */
function normalizePublicUrl(input) {
  let url = input
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url
  url = url.replace(/\/+$/, '')
  return url
}

/**
 * Print the client install command in a box-drawn ASCII frame so it's hard
 * for an admin to scroll past without copying.
 *
 * @param {{ write: (s: string) => void }} stdout
 * @param {string} publicUrl
 */
function printClientInstallBox(stdout, publicUrl) {
  const command = `npx collectivus --config ${publicUrl}/collectivus.json`
  const lines = [
    'Run this on each client machine to point it at the server:',
    '',
    command,
  ]
  stdout.write('\n' + asciiBox(lines) + '\n')
}

/**
 * Wrap `lines` in a Unicode box-drawing frame. Width fits the longest line.
 *
 * @param {string[]} lines
 * @returns {string}
 */
function asciiBox(lines) {
  const width = lines.reduce(function(m, l) { return Math.max(m, l.length) }, 0)
  const pad = 2
  const inner = width + pad * 2
  const top = '╔' + '═'.repeat(inner) + '╗'
  const bot = '╚' + '═'.repeat(inner) + '╝'
  const middle = lines.map(function(l) {
    return '║' + ' '.repeat(pad) + l + ' '.repeat(width - l.length) + ' '.repeat(pad) + '║'
  })
  return [top, ...middle, bot].join('\n') + '\n'
}

/**
 * Prompt for daemon install + Claude Code attach when the platform supports it
 * and the config has a proxy listener. Otherwise prints next-step hints.
 *
 * Skips the daemon install offer when running via npx — daemonizing requires a
 * persistent binary, which an npx-resolved path under `_npx/` is not.
 *
 * @param {{
 *   configPath: string,
 *   wantProxy: boolean,
 *   stdout: { write: (s: string) => void },
 *   prompt: (q: string) => Promise<string>,
 *   platform: NodeJS.Platform,
 *   binPath: string,
 *   runInstall?: (args: string[]) => Promise<number>,
 *   offerClaudeCode: boolean,
 * }} args
 * @returns {Promise<number>}
 */
async function offerDaemonInstall(args) {
  const { configPath, wantProxy, stdout, prompt, platform, binPath, offerClaudeCode } = args
  const viaNpx = isNpxBinPath(binPath)
  if (wantProxy && (platform === 'darwin' || platform === 'linux') && !viaNpx) {
    const daemonKind = platform === 'darwin' ? 'launchd LaunchAgent' : 'systemd user unit'
    stdout.write('\nRun collectivus as a background daemon?\n')
    stdout.write(`  Yes → installs a ${daemonKind} that starts at login and respawns\n`)
    stdout.write('        if it crashes. Logs go to ~/.hyp/collectivus/. Reversible\n')
    stdout.write('        with `collectivus uninstall`.\n')
    stdout.write('  No  → only runs while you launch it manually with\n')
    stdout.write('        `collectivus --config <path>` in a terminal.\n')
    const dAns = (await prompt('Install as background daemon? [Y/n]: ')).trim()
    if (isYes(dAns)) {
      let installFlag
      if (offerClaudeCode) {
        stdout.write('\nConfigure Claude Code to route through this proxy?\n')
        stdout.write('  Yes → adds ANTHROPIC_BASE_URL=http://127.0.0.1:<port> to\n')
        stdout.write('        ~/.claude/settings.json so the `claude` CLI uses the proxy.\n')
        stdout.write('        Reversible with `collectivus detach`.\n')
        stdout.write('  No  → leaves Claude Code untouched; attach later with\n')
        stdout.write('        `collectivus attach`.\n')
        const cAns = (await prompt('Configure Claude Code? [Y/n]: ')).trim()
        installFlag = isYes(cAns) ? '--yes' : '--no'
      } else {
        // Server installs don't ask about Claude Code: this machine is the
        // upstream other people's claude CLIs route through, not a workstation.
        installFlag = '--no'
      }
      const installArgs = ['--config', configPath, installFlag]
      const runInstallFn = args.runInstall ?? await loadRunInstall()
      return runInstallFn(installArgs)
    }
  }

  stdout.write('\nNext steps:\n')
  if (viaNpx) {
    stdout.write(`  npx collectivus --config ${configPath}\n`)
  } else {
    stdout.write(`  collectivus --config ${configPath}\n`)
  }
  if (wantProxy && (platform === 'darwin' || platform === 'linux')) {
    if (viaNpx) {
      stdout.write('\nTo run collectivus as a background daemon, install it globally first:\n')
      stdout.write('  npm install -g collectivus\n')
      stdout.write(`  collectivus install --config ${configPath}\n`)
    } else {
      stdout.write(`  collectivus install --config ${configPath}   (run as a background daemon)\n`)
    }
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
 *   binPath: string,
 *   runInstall?: (args: string[]) => Promise<number>,
 * }} args
 * @returns {Promise<number>}
 */
function useExistingConfig(args) {
  const wantProxy = args.config.proxy !== undefined
  return offerDaemonInstall({
    configPath: args.configPath, wantProxy,
    stdout: args.stdout, prompt: args.prompt, platform: args.platform,
    binPath: args.binPath,
    runInstall: args.runInstall,
    offerClaudeCode: true,
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
