import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const cliPath = fileURLToPath(new URL('../bin/cli.js', import.meta.url))

/**
 * Spawn the CLI with the given args and capture stdio + exit code.
 *
 * @param {string[]} args
 * @returns {Promise<{ exitCode: number, stdout: string, stderr: string }>}
 */
function runCli(args) {
  return new Promise(function(resolve, reject) {
    const child = spawn(process.execPath, [cliPath, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', function(c) { stdout += c.toString() })
    child.stderr.on('data', function(c) { stderr += c.toString() })
    child.once('error', reject)
    child.once('exit', function(code) { resolve({ exitCode: code ?? -1, stdout, stderr }) })
  })
}

describe('bin/cli.js — subcommand dispatch', function() {
  it('dispatches `install --help`', async function() {
    const r = await runCli(['install', '--help'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toMatch(/Usage:\s+collectivus install/)
  })

  it('dispatches `uninstall --help`', async function() {
    const r = await runCli(['uninstall', '--help'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toMatch(/Usage:\s+collectivus uninstall/)
  })

  it('dispatches `attach --help`', async function() {
    const r = await runCli(['attach', '--help'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toMatch(/Usage:\s+collectivus attach/)
  })

  it('dispatches `detach --help`', async function() {
    const r = await runCli(['detach', '--help'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toMatch(/Usage:\s+collectivus detach/)
  })

  it('dispatches `status --help`', async function() {
    const r = await runCli(['status', '--help'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toMatch(/Usage:\s+collectivus status/)
  })

  it('dispatches `config --help`', async function() {
    const r = await runCli(['config', '--help'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toMatch(/Usage:\s+collectivus config set/)
  })

  it('dispatches `export --help`', async function() {
    const r = await runCli(['export', '--help'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toMatch(/Usage:\s+collectivus export/)
  })

  it('passes subcommand args through (install with no --config)', async function() {
    const r = await runCli(['install'])
    expect(r.exitCode).toBe(2)
    expect(r.stderr).toMatch(/--config is required/)
  })

  it('falls through to listener mode for non-subcommand args', async function() {
    const r = await runCli(['--help'])
    expect(r.exitCode).toBe(0)
    // Top-level USAGE wording, not a subcommand-specific Usage.
    expect(r.stdout).toMatch(/--config <path\|url>\s+Run with config file/)
  })
})
