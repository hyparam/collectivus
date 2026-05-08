#!/usr/bin/env node

import process from 'node:process'

const SUBCOMMANDS = new Set(['install', 'uninstall', 'attach', 'detach', 'status'])

const argv = process.argv.slice(2)
const subcommand = argv[0]

main().then(
  function(code) { process.exit(code) },
  function(err) {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
)

/**
 * Dispatch to a subcommand handler when the first argument matches one of the
 * installer commands; otherwise fall through to the long-running listener
 * lifecycle in `src/cli.js`.
 *
 * @returns {Promise<number>}
 */
async function main() {
  if (subcommand && SUBCOMMANDS.has(subcommand)) {
    const subArgs = argv.slice(1)
    const handler = await loadSubcommand(subcommand)
    return handler(subArgs)
  }
  const { run } = await import('../src/cli.js')
  return run(argv, process.env)
}

/**
 * @param {string} name
 * @returns {Promise<(args: string[]) => Promise<number>>}
 */
async function loadSubcommand(name) {
  switch (name) {
  case 'install': {
    const { runInstall } = await import('../src/cli/install.js')
    return runInstall
  }
  case 'uninstall': {
    const { runUninstall } = await import('../src/cli/uninstall.js')
    return runUninstall
  }
  case 'attach': {
    const { runAttach } = await import('../src/cli/attach.js')
    return runAttach
  }
  case 'detach': {
    const { runDetach } = await import('../src/cli/detach.js')
    return runDetach
  }
  case 'status': {
    const { runStatus } = await import('../src/cli/status.js')
    return runStatus
  }
  default:
    throw new Error(`unknown subcommand: ${name}`)
  }
}
