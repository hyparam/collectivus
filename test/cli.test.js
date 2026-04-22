import { describe, expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const cliPath = fileURLToPath(new URL('../bin/cli.js', import.meta.url))

/**
 * @param {import('node:child_process').ChildProcessWithoutNullStreams} child
 * @param {string} needle
 * @returns {Promise<void>} resolves when stdout contains `needle`.
 */
function waitForStdout(child, needle) {
  return new Promise((resolve, reject) => {
    let buf = ''
    function onData(/** @type {Buffer} */ chunk) {
      buf += chunk.toString()
      if (buf.includes(needle)) {
        child.stdout.off('data', onData)
        resolve()
      }
    }
    child.stdout.on('data', onData)
    child.once('error', reject)
    child.once('exit', () => reject(new Error(`exited before "${needle}": ${buf}`)))
  })
}

describe('CLI signal handling', () => {
  it('shuts down gracefully on SIGTERM', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-sigterm-'))
    const child = spawn(process.execPath, [cliPath, '--port=0', '--output', outputDir])
    try {
      await waitForStdout(child, 'listening')
      const exit = new Promise((resolve) => {
        child.once('exit', (code, signal) => resolve({ code, signal }))
      })
      child.kill('SIGTERM')
      const result = await exit
      expect(result).toEqual({ code: 0, signal: null })
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL')
      fs.rmSync(outputDir, { recursive: true, force: true })
    }
  }, 10000)

  it('uses env vars when argv is absent', async () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-env-'))
    const child = spawn(process.execPath, [cliPath], {
      env: {
        ...process.env,
        COLLECTIVUS_PORT: '0',
        COLLECTIVUS_OUTPUT_DIR: outputDir,
      },
    })
    try {
      await waitForStdout(child, outputDir)
      const exit = new Promise((resolve) => {
        child.once('exit', (code) => resolve(code))
      })
      child.kill('SIGTERM')
      expect(await exit).toBe(0)
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL')
      fs.rmSync(outputDir, { recursive: true, force: true })
    }
  }, 10000)
})
