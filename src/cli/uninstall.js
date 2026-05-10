import process from 'node:process'
import { detach as defaultDetachClaude, isAttached as defaultIsClaudeAttached, defaultSettingsPath } from '../claude-code/settings.js'
import { defaultConfigPath as defaultCodexConfigPath, detach as defaultDetachCodex, isAttached as defaultIsCodexAttached } from '../codex/settings.js'
import { LAUNCH_AGENT_LABEL, daemonKindLabel, defaultPrompt } from './common.js'
import { uninstallDaemon } from '../daemon/index.js'

/**
 * @import { UninstallParseResult, UninstallHooks } from '../types.js'
 */

const USAGE = `Usage:
  collectivus uninstall [--detach] [--client claude|codex|all]

Options:
  --detach          Also revert selected client config without prompting
  --client <name>   Tool to restore when detaching: claude, codex, or all (default: claude)
  --help, -h        Show this help`

/**
 * Parse the argument list of `collectivus uninstall`.
 *
 * @param {string[]} argv
 * @returns {UninstallParseResult}
 */
export function parseUninstallArgs(argv) {
  /** @type {UninstallParseResult} */
  const r = { detach: false, help: false, client: 'claude' }
  let detach = false
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') {
      r.detach = detach
      r.help = true
      return r
    }
    if (arg === '--detach') { detach = true; r.detach = true; continue }
    if (arg === '--client' || arg.startsWith('--client=')) {
      const value = arg === '--client' ? argv[++i] : arg.slice('--client='.length)
      if (!value) { r.error = '--client requires claude, codex, or all'; return r }
      if (value !== 'claude' && value !== 'codex' && value !== 'all') {
        r.error = `--client: expected claude, codex, or all (got "${value}")`
        return r
      }
      r.client = value
      continue
    }
    r.error = `unknown argument: ${arg}`
    return r
  }
  r.detach = detach
  return r
}

/**
 * Run `collectivus uninstall`.
 *
 * Removes the LaunchAgent. When `--detach` is given, also reverts selected
 * client settings unconditionally; otherwise prompts (TTY) or skips (non-TTY)
 * the detach step. Always reports the final state.
 *
 * @param {string[]} argv
 * @param {UninstallHooks} [hooks]
 * @returns {Promise<number>}
 */
export async function runUninstall(argv, hooks = {}) {
  const stdout = hooks.stdout ?? process.stdout
  const stderr = hooks.stderr ?? process.stderr
  const uninstallFn = hooks.uninstallLaunchAgent ?? uninstallDaemon
  const detachClaude = hooks.detachClaude ?? hooks.detach ?? defaultDetachClaude
  const detachCodex = hooks.detachCodex ?? defaultDetachCodex
  const isClaudeAttached = hooks.isClaudeAttached ?? hooks.isAttached ?? defaultIsClaudeAttached
  const isCodexAttached = hooks.isCodexAttached ?? defaultIsCodexAttached
  const settingsPath = hooks.settingsPath ?? defaultSettingsPath()
  const codexConfigPath = hooks.codexConfigPath ?? defaultCodexConfigPath()
  const promptFn = hooks.prompt ?? defaultPrompt
  const isTTY = hooks.isTTY ?? Boolean(process.stdin.isTTY)

  const parsed = parseUninstallArgs(argv)
  if (parsed.help) {
    stdout.write(USAGE + '\n')
    return 0
  }
  if (parsed.error) {
    stderr.write(`error: ${parsed.error}\n\n${USAGE}\n`)
    return 2
  }

  try {
    await uninstallFn({
      label: LAUNCH_AGENT_LABEL,
      ...hooks.plistDir !== undefined ? { plistDir: hooks.plistDir } : {},
    })
  } catch (err) {
    stderr.write(`error: failed to uninstall daemon: ${formatError(err)}\n`)
    return 1
  }
  stdout.write(`✓ Daemon removed (${daemonKindLabel()})\n`)

  /** @type {boolean} */
  let shouldDetach
  if (parsed.detach) {
    shouldDetach = true
  } else {
    /** @type {Array<{ client: 'claude' | 'codex', attached: boolean }>} */
    let attachedStates
    try {
      attachedStates = await readAttachStates(parsed.client, {
        isClaudeAttached,
        isCodexAttached,
        settingsPath,
        codexConfigPath,
      })
    } catch (err) {
      stderr.write(`error: failed to read client configuration: ${formatError(err)}\n`)
      return 1
    }
    if (!attachedStates.some(function(state) { return state.attached })) {
      for (const client of selectedClients(parsed.client)) {
        stdout.write(`  ${clientLabel(client)}: not attached, nothing to revert\n`)
      }
      return 0
    }
    if (isTTY) {
      const answer = await promptFn(`Also revert ${promptClientLabel(parsed.client)} configuration? [Y/n] `)
      shouldDetach = answer === '' || /^y(es)?$/i.test(answer)
    } else {
      stderr.write(nonTtyDetachWarning(parsed.client))
      shouldDetach = false
    }
  }

  if (shouldDetach) {
    for (const client of selectedClients(parsed.client)) {
      if (client === 'claude') {
        try {
          const result = await detachClaude({ settingsPath })
          if (result.changed) {
            stdout.write(`✓ Claude Code reverted (${settingsPath})\n`)
            if (result.warning) stdout.write(`  warning: ${result.warning}\n`)
          } else {
            stdout.write('  Claude Code: no marker found, nothing to revert\n')
          }
        } catch (err) {
          stderr.write(`error: failed to revert Claude Code: ${formatError(err)}\n`)
          return 1
        }
      } else {
        try {
          const result = await detachCodex({ configPath: codexConfigPath })
          if (result.changed) {
            stdout.write(`✓ Codex reverted (${codexConfigPath})\n`)
            if (result.removed) stdout.write(`  Removed base_url=${result.removed}\n`)
            if (result.restoredValue) stdout.write(`  Restored model_provider=${result.restoredValue}\n`)
            if (result.warning) stdout.write(`  warning: ${result.warning}\n`)
          } else {
            stdout.write('  Codex: no marker found, nothing to revert\n')
          }
        } catch (err) {
          stderr.write(`error: failed to revert Codex: ${formatError(err)}\n`)
          return 1
        }
      }
    }
  } else {
    stdout.write(`  ${promptClientLabel(parsed.client)} revert: skipped\n`)
  }

  return 0
}

/**
 * @param {'claude' | 'codex' | 'all'} client
 * @returns {Array<'claude' | 'codex'>}
 */
function selectedClients(client) {
  return client === 'all' ? ['claude', 'codex'] : [client]
}

/**
 * @param {'claude' | 'codex' | 'all'} client
 * @param {{
 *   isClaudeAttached: (opts?: { settingsPath?: string }) => Promise<boolean>,
 *   isCodexAttached: (opts?: { configPath?: string }) => Promise<boolean>,
 *   settingsPath: string,
 *   codexConfigPath: string,
 * }} ctx
 * @returns {Promise<Array<{ client: 'claude' | 'codex', attached: boolean }>>}
 */
async function readAttachStates(client, ctx) {
  /** @type {Array<{ client: 'claude' | 'codex', attached: boolean }>} */
  const states = []
  for (const selected of selectedClients(client)) {
    if (selected === 'claude') {
      states.push({
        client: selected,
        attached: await ctx.isClaudeAttached({ settingsPath: ctx.settingsPath }),
      })
    } else {
      states.push({
        client: selected,
        attached: await ctx.isCodexAttached({ configPath: ctx.codexConfigPath }),
      })
    }
  }
  return states
}

/**
 * @param {'claude' | 'codex'} client
 * @returns {string}
 */
function clientLabel(client) {
  return client === 'claude' ? 'Claude Code' : 'Codex'
}

/**
 * @param {'claude' | 'codex' | 'all'} client
 * @returns {string}
 */
function promptClientLabel(client) {
  if (client === 'claude') return 'Claude Code'
  if (client === 'codex') return 'Codex'
  return 'Claude Code and Codex'
}

/**
 * @param {'claude' | 'codex' | 'all'} client
 * @returns {string}
 */
function nonTtyDetachWarning(client) {
  if (client === 'claude') {
    return 'warning: not a TTY; leaving Claude Code attached. ' +
      'Run `collectivus detach` (or rerun with --detach) to revert.\n'
  }
  if (client === 'codex') {
    return 'warning: not a TTY; leaving Codex attached. ' +
      'Run `collectivus detach --client codex` (or rerun with --detach --client codex) to revert.\n'
  }
  return 'warning: not a TTY; leaving Claude Code and Codex attached. ' +
    'Run `collectivus detach --client all` (or rerun with --detach --client all) to revert.\n'
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function formatError(err) {
  return err instanceof Error ? err.message : String(err)
}
