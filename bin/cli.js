#!/usr/bin/env node

import { Collector } from '../src/index.js'
import { resolveOptions } from '../src/config.js'

const options = resolveOptions(process.argv.slice(2), process.env)
const collector = new Collector(options)

collector.start().then(function() {
  console.log(`Collectivus listening on port ${collector.port}`)
  console.log(`Writing to ${collector.outputDir}`)
})

function shutdown() {
  console.log('\nShutting down...')
  collector.stop().then(function() {
    process.exit(0)
  })
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
