import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const DEFAULT_PLIST_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents')

export class LaunchAgentError extends Error {
  /**
   * @param {string} message
   * @param {{ exitCode?: number, stderr?: string }} [opts]
   */
  constructor(message, opts = {}) {
    super(message)
    this.name = 'LaunchAgentError'
    /** @type {number | undefined} */
    this.exitCode = opts.exitCode
    /** @type {string | undefined} */
    this.stderr = opts.stderr
  }
}

/**
 * @typedef {object} LaunchctlResult
 * @property {number} exitCode - Exit code from the launchctl invocation.
 * @property {string} stdout - Captured standard output.
 * @property {string} stderr - Captured standard error.
 */

/**
 * Adapter for invoking the `launchctl` binary. Concrete implementation uses
 * `child_process.spawn`; tests inject a fake to avoid touching the real
 * launchd domain.
 *
 * @typedef {object} LaunchctlAdapter
 * @property {(plistPath: string) => Promise<LaunchctlResult>} load - Run `launchctl load <path>`.
 * @property {(plistPath: string) => Promise<LaunchctlResult>} unload - Run `launchctl unload <path>`.
 * @property {(label: string) => Promise<LaunchctlResult>} list - Run `launchctl list <label>`.
 */

/** @type {LaunchctlAdapter} */
export const realLaunchctl = {
  load(plistPath) { return runLaunchctl(['load', plistPath]) },
  unload(plistPath) { return runLaunchctl(['unload', plistPath]) },
  list(label) { return runLaunchctl(['list', label]) },
}

/**
 * @param {string[]} args
 * @returns {Promise<LaunchctlResult>}
 */
function runLaunchctl(args) {
  return new Promise(function(resolve, reject) {
    const proc = spawn('launchctl', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', function(chunk) { stdout += chunk.toString('utf8') })
    proc.stderr.on('data', function(chunk) { stderr += chunk.toString('utf8') })
    proc.on('error', reject)
    proc.on('close', function(code) {
      resolve({ exitCode: code === null ? -1 : code, stdout, stderr })
    })
  })
}

/**
 * @typedef {object} BuildPlistOptions
 * @property {string} label - The Label key of the plist (e.g. 'com.hyparam.collectivus').
 * @property {string} nodePath - Path to the node executable to invoke.
 * @property {string} binPath - Absolute path to the script to run.
 * @property {string} configPath - Absolute path to the config file to pass via --config.
 * @property {string} logDir - Directory where stdout/stderr logs are written.
 * @property {Record<string, string>} [env] - Optional EnvironmentVariables. Omit the key when undefined.
 * @property {boolean} [keepAlive] - Whether to set KeepAlive=true. Defaults to true.
 * @property {boolean} [runAtLoad] - Whether to set RunAtLoad=true. Defaults to true.
 */

/**
 * Build the XML body of a LaunchAgent plist.
 *
 * Output is deterministic for the same inputs so tests can compare against
 * fixed strings. Strings are XML-escaped; ProgramArguments is rendered with
 * each argv element on its own line for readability.
 *
 * @param {BuildPlistOptions} options
 * @returns {string} The plist XML, with a trailing newline.
 */
export function buildPlist(options) {
  const { label, nodePath, binPath, configPath, logDir, env } = options
  const keepAlive = options.keepAlive !== false
  const runAtLoad = options.runAtLoad !== false

  if (!label || typeof label !== 'string') throw new LaunchAgentError('label is required')
  if (!nodePath || typeof nodePath !== 'string') throw new LaunchAgentError('nodePath is required')
  if (!binPath || typeof binPath !== 'string') throw new LaunchAgentError('binPath is required')
  if (!configPath || typeof configPath !== 'string') throw new LaunchAgentError('configPath is required')
  if (!logDir || typeof logDir !== 'string') throw new LaunchAgentError('logDir is required')

  const stdoutPath = path.join(logDir, 'collectivus.log')
  const stderrPath = path.join(logDir, 'collectivus.err.log')

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '  <key>Label</key>',
    `  <string>${escapeXml(label)}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    `    <string>${escapeXml(nodePath)}</string>`,
    `    <string>${escapeXml(binPath)}</string>`,
    '    <string>--config</string>',
    `    <string>${escapeXml(configPath)}</string>`,
    '  </array>',
    '  <key>RunAtLoad</key>',
    `  ${runAtLoad ? '<true/>' : '<false/>'}`,
    '  <key>KeepAlive</key>',
    `  ${keepAlive ? '<true/>' : '<false/>'}`,
    '  <key>StandardOutPath</key>',
    `  <string>${escapeXml(stdoutPath)}</string>`,
    '  <key>StandardErrorPath</key>',
    `  <string>${escapeXml(stderrPath)}</string>`,
  ]

  if (env !== undefined) {
    if (env === null || typeof env !== 'object' || Array.isArray(env)) {
      throw new LaunchAgentError('env must be an object of string values')
    }
    const entries = Object.entries(env)
    lines.push('  <key>EnvironmentVariables</key>')
    if (entries.length === 0) {
      lines.push('  <dict/>')
    } else {
      lines.push('  <dict>')
      for (const [key, value] of entries) {
        if (typeof value !== 'string') {
          throw new LaunchAgentError(`env.${key} must be a string`)
        }
        lines.push(`    <key>${escapeXml(key)}</key>`)
        lines.push(`    <string>${escapeXml(value)}</string>`)
      }
      lines.push('  </dict>')
    }
  }

  lines.push('</dict>', '</plist>', '')
  return lines.join('\n')
}

/**
 * @param {string} value
 * @returns {string}
 */
function escapeXml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * @typedef {object} InstallOptions
 * @property {string} binPath - Path to the script to run under node.
 * @property {string} configPath - Path to the JSON config to pass via --config.
 * @property {string} label - LaunchAgent label (used as the plist filename).
 * @property {string} logDir - Directory for stdout/stderr logs.
 * @property {string} [nodePath] - Override node executable. Defaults to process.execPath.
 * @property {Record<string, string>} [env] - Optional EnvironmentVariables.
 * @property {boolean} [keepAlive] - Override KeepAlive. Defaults to true.
 * @property {boolean} [runAtLoad] - Override RunAtLoad. Defaults to true.
 * @property {string} [plistDir] - Override directory for the plist file. Defaults to ~/Library/LaunchAgents.
 * @property {LaunchctlAdapter} [launchctl] - Override launchctl adapter (used by tests).
 */

/**
 * Install or refresh a LaunchAgent.
 *
 * Idempotent: if the agent is already loaded, it is unloaded before the new
 * plist is written and re-loaded. The plist is written atomically (tmp +
 * rename) so a crash mid-write leaves the previous file intact.
 *
 * @param {InstallOptions} options
 * @returns {Promise<void>}
 */
export async function installLaunchAgent(options) {
  const launchctl = options.launchctl ?? realLaunchctl
  const plistDir = options.plistDir ?? DEFAULT_PLIST_DIR
  const nodePath = options.nodePath ?? process.execPath

  const plistPath = plistPathFor(plistDir, options.label)
  const content = buildPlist({
    label: options.label,
    nodePath,
    binPath: options.binPath,
    configPath: options.configPath,
    logDir: options.logDir,
    env: options.env,
    keepAlive: options.keepAlive,
    runAtLoad: options.runAtLoad,
  })

  fs.mkdirSync(plistDir, { recursive: true })
  fs.mkdirSync(options.logDir, { recursive: true })

  const status = await launchctl.list(options.label)
  if (status.exitCode === 0 && fs.existsSync(plistPath)) {
    const unloadResult = await launchctl.unload(plistPath)
    if (unloadResult.exitCode !== 0) {
      throw new LaunchAgentError(
        `failed to unload existing LaunchAgent ${options.label}: ${unloadResult.stderr.trim() || `exit ${unloadResult.exitCode}`}`,
        { exitCode: unloadResult.exitCode, stderr: unloadResult.stderr }
      )
    }
  }

  atomicWrite(plistPath, content)

  const loadResult = await launchctl.load(plistPath)
  if (loadResult.exitCode !== 0) {
    throw new LaunchAgentError(
      `failed to load LaunchAgent ${options.label}: ${loadResult.stderr.trim() || `exit ${loadResult.exitCode}`}`,
      { exitCode: loadResult.exitCode, stderr: loadResult.stderr }
    )
  }
}

/**
 * @typedef {object} UninstallOptions
 * @property {string} label - LaunchAgent label to remove.
 * @property {string} [plistDir] - Override directory for the plist file. Defaults to ~/Library/LaunchAgents.
 * @property {LaunchctlAdapter} [launchctl] - Override launchctl adapter (used by tests).
 */

/**
 * Unload and remove a LaunchAgent.
 *
 * Tolerates already-unloaded state and a missing plist file. The unload step
 * is best-effort so that a stale plist file can always be cleaned up even when
 * launchctl reports the service was already gone.
 *
 * @param {UninstallOptions} options
 * @returns {Promise<void>}
 */
export async function uninstallLaunchAgent(options) {
  const launchctl = options.launchctl ?? realLaunchctl
  const plistDir = options.plistDir ?? DEFAULT_PLIST_DIR
  const plistPath = plistPathFor(plistDir, options.label)

  if (fs.existsSync(plistPath)) {
    await launchctl.unload(plistPath) // best-effort; tolerate failures
    try {
      fs.unlinkSync(plistPath)
    } catch (err) {
      const code = err && typeof err === 'object' && 'code' in err ? err.code : null
      if (code !== 'ENOENT') throw err
    }
  }
}

/**
 * @typedef {object} StatusOptions
 * @property {string} label - LaunchAgent label to query.
 * @property {string} [plistDir] - Unused; accepted for API symmetry.
 * @property {LaunchctlAdapter} [launchctl] - Override launchctl adapter (used by tests).
 */

/**
 * Query whether the plist file for a label is installed on disk.
 *
 * @param {{ label: string, plistDir?: string }} options
 * @returns {Promise<boolean>}
 */
export function isLaunchAgentInstalled(options) {
  const plistDir = options.plistDir ?? DEFAULT_PLIST_DIR
  return Promise.resolve(fs.existsSync(plistPathFor(plistDir, options.label)))
}

/**
 * Query the runtime status of a LaunchAgent via `launchctl list <label>`.
 *
 * Returns `{ loaded: false }` when launchctl reports the service is not in
 * its domain. When loaded, includes a `pid` only if the agent currently has
 * a running process — short-lived agents that have already exited will be
 * reported as `{ loaded: true }` with no pid field.
 *
 * @param {StatusOptions} options
 * @returns {Promise<{ loaded: boolean, pid?: number }>}
 */
export async function launchAgentStatus(options) {
  const launchctl = options.launchctl ?? realLaunchctl
  const result = await launchctl.list(options.label)
  if (result.exitCode !== 0) {
    return { loaded: false }
  }
  const pid = parsePid(result.stdout)
  return pid === undefined ? { loaded: true } : { loaded: true, pid }
}

/**
 * Extract the numeric PID from a `launchctl list <label>` plist dump.
 *
 * launchctl prints a textual property list; the PID line looks like
 * `\t"PID" = 12345;`. When the agent is loaded but not currently running
 * (e.g. throttled or KeepAlive=false after exit), the PID line is absent.
 *
 * @param {string} stdout
 * @returns {number | undefined}
 */
function parsePid(stdout) {
  const match = /"PID"\s*=\s*(\d+)\s*;/.exec(stdout)
  if (!match) return undefined
  const n = Number.parseInt(match[1], 10)
  return Number.isInteger(n) ? n : undefined
}

/**
 * @param {string} dir
 * @param {string} label
 * @returns {string}
 */
function plistPathFor(dir, label) {
  return path.join(dir, `${label}.plist`)
}

/**
 * Write `content` to `targetPath` atomically by writing to a sibling tmp
 * file and renaming. fs.renameSync is atomic on the same filesystem on
 * macOS, so a crash mid-write leaves the previous file (or no file) intact.
 *
 * @param {string} targetPath
 * @param {string} content
 * @returns {void}
 */
function atomicWrite(targetPath, content) {
  const tmpPath = `${targetPath}.tmp.${process.pid}.${Date.now()}`
  fs.writeFileSync(tmpPath, content, { mode: 0o644 })
  try {
    fs.renameSync(tmpPath, targetPath)
  } catch (err) {
    try { fs.unlinkSync(tmpPath) } catch { /* ignore */ }
    throw err
  }
}
