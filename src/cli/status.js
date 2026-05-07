import fs from 'node:fs/promises'
import process from 'node:process'
import { isAttached as defaultIsAttached, defaultSettingsPath } from '../claude-code/settings.js'
import {
  LAUNCH_AGENT_LABEL,
  defaultLogDir,
  defaultPlistPath,
  readInstalledPlist as defaultReadInstalledPlist,
} from './common.js'
import { isLaunchAgentInstalled as defaultIsLaunchAgentInstalled, launchAgentStatus as defaultLaunchAgentStatus } from '../daemon/macos.js'

const USAGE = `Usage:
  collectivus status

Options:
  --help, -h        Show this help`

/**
 * @typedef {object} StatusParseResult
 * @property {boolean} help
 * @property {string|null} error
 */

/**
 * @param {string[]} argv
 * @returns {StatusParseResult}
 */
export function parseStatusArgs(argv) {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') return { help: true, error: null }
    return { help: false, error: `unknown argument: ${arg}` }
  }
  return { help: false, error: null }
}

/**
 * @typedef {object} CollectivusMarker
 * @property {string} [attached_at]
 * @property {string} [version]
 * @property {number} [port]
 */

/**
 * @typedef {object} StatusHooks
 * @property {{ write: (s: string) => void }} [stdout]
 * @property {{ write: (s: string) => void }} [stderr]
 * @property {string} [plistPath]
 * @property {string} [logDir]
 * @property {string} [settingsPath]
 * @property {typeof defaultLaunchAgentStatus} [launchAgentStatus]
 * @property {typeof defaultIsLaunchAgentInstalled} [isLaunchAgentInstalled]
 * @property {typeof defaultIsAttached} [isAttached]
 * @property {typeof defaultReadInstalledPlist} [readInstalledPlist]
 * @property {(p: string) => Promise<string|null>} [readSettingsRaw] - Override for raw read of settings.json (returns null on ENOENT).
 */

/**
 * Run `collectivus status`.
 *
 * Reports the LaunchAgent's loaded/PID state and Claude Code attach state in
 * a single human-readable block. The exit code is 0 unless an error makes the
 * report itself unreliable (e.g. settings.json is malformed).
 *
 * @param {string[]} argv
 * @param {StatusHooks} [hooks]
 * @returns {Promise<number>}
 */
export async function runStatus(argv, hooks = {}) {
  const stdout = hooks.stdout ?? process.stdout
  const stderr = hooks.stderr ?? process.stderr

  const parsed = parseStatusArgs(argv)
  if (parsed.help) {
    stdout.write(USAGE + '\n')
    return 0
  }
  if (parsed.error) {
    stderr.write(`error: ${parsed.error}\n\n${USAGE}\n`)
    return 2
  }

  const launchAgentStatus = hooks.launchAgentStatus ?? defaultLaunchAgentStatus
  const isLaunchAgentInstalled = hooks.isLaunchAgentInstalled ?? defaultIsLaunchAgentInstalled
  const isAttached = hooks.isAttached ?? defaultIsAttached
  const readInstalledPlistFn = hooks.readInstalledPlist ?? defaultReadInstalledPlist
  const readSettingsRaw = hooks.readSettingsRaw ?? defaultReadSettingsRaw
  const plistPath = hooks.plistPath ?? defaultPlistPath()
  const settingsPath = hooks.settingsPath ?? defaultSettingsPath()
  const logDir = hooks.logDir ?? defaultLogDir()

  const exitCode = 0

  // --- Daemon section ---
  stdout.write('Daemon\n')
  /** @type {boolean} */
  let installed
  try {
    installed = await isLaunchAgentInstalled({ label: LAUNCH_AGENT_LABEL, plistDir: plistDirOf(plistPath) })
  } catch (err) {
    stderr.write(`error: failed to check daemon installation: ${formatError(err)}\n`)
    return 1
  }

  if (!installed) {
    stdout.write('  Status: not installed\n')
    stdout.write(`  Plist: ${plistPath} (missing)\n`)
  } else {
    /** @type {{ loaded: boolean, pid?: number }} */
    let agentStatus
    try {
      agentStatus = await launchAgentStatus({ label: LAUNCH_AGENT_LABEL })
    } catch (err) {
      stderr.write(`warning: failed to query launchctl: ${formatError(err)}\n`)
      agentStatus = { loaded: false }
    }
    stdout.write(`  Status: ${formatAgentStatus(agentStatus)}\n`)
    stdout.write(`  Plist: ${plistPath}\n`)

    /** @type {import('./common.js').InstalledPlistFields | null} */
    let plistFields
    try {
      plistFields = readInstalledPlistFn(plistPath)
    } catch (err) {
      stderr.write(`warning: failed to parse plist: ${formatError(err)}\n`)
      plistFields = null
    }
    const configPath = plistFields?.configPath ?? null
    const stdoutPath = plistFields?.stdoutPath ?? `${logDir}/collectivus.log`
    const stderrPath = plistFields?.stderrPath ?? `${logDir}/collectivus.err.log`
    if (configPath) stdout.write(`  Config: ${configPath}\n`)
    stdout.write('  Logs:\n')
    stdout.write(`    stdout: ${stdoutPath}\n`)
    stdout.write(`    stderr: ${stderrPath}\n`)
  }

  // --- Claude Code section ---
  stdout.write('\nClaude Code\n')
  /** @type {boolean} */
  let attached
  try {
    attached = await isAttached({ settingsPath })
  } catch (err) {
    stderr.write(`error: failed to read ${settingsPath}: ${formatError(err)}\n`)
    stdout.write('  Status: unknown (settings.json could not be parsed)\n')
    stdout.write(`  Settings: ${settingsPath}\n`)
    return 1
  }

  if (!attached) {
    stdout.write('  Status: not attached\n')
    stdout.write(`  Settings: ${settingsPath}\n`)
    return exitCode
  }

  /** @type {CollectivusMarker | null} */
  let marker = null
  try {
    const raw = await readSettingsRaw(settingsPath)
    if (raw !== null) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && parsed._collectivus
          && typeof parsed._collectivus === 'object' && !Array.isArray(parsed._collectivus)) {
        marker = parsed._collectivus
      }
    }
  } catch (err) {
    // isAttached already accepted the file, so a parse failure here is unexpected.
    // Keep going with marker=null so we can still report the attached status.
    stderr.write(`warning: failed to parse marker: ${formatError(err)}\n`)
  }

  stdout.write('  Status: attached\n')
  if (marker?.attached_at) stdout.write(`  Attached at: ${marker.attached_at}\n`)
  if (typeof marker?.port === 'number') stdout.write(`  Port: ${marker.port}\n`)
  if (typeof marker?.version === 'string') stdout.write(`  Marker version: ${marker.version}\n`)
  stdout.write(`  Settings: ${settingsPath}\n`)
  return exitCode
}

/**
 * @param {{ loaded: boolean, pid?: number }} status
 * @returns {string}
 */
function formatAgentStatus(status) {
  if (!status.loaded) return 'installed but not loaded'
  if (typeof status.pid === 'number') return `loaded (PID ${status.pid})`
  return 'loaded (no PID; daemon may have exited)'
}

/**
 * @param {string} p
 * @returns {string}
 */
function plistDirOf(p) {
  const slash = p.lastIndexOf('/')
  return slash === -1 ? p : p.slice(0, slash)
}

/**
 * @param {string} p
 * @returns {Promise<string|null>}
 */
async function defaultReadSettingsRaw(p) {
  try {
    return await fs.readFile(p, 'utf8')
  } catch (err) {
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT') return null
    throw err
  }
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}
