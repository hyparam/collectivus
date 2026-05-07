#!/usr/bin/env node

import process from 'node:process'
import { run } from '../src/cli.js'

run(process.argv.slice(2), process.env).then(
  function(code) { process.exit(code) },
  function(err) {
    process.stderr.write(`fatal: ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  }
)
