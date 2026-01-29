#!/usr/bin/env node

import { Collector } from '../src/index.js'

function parseArgs(args) {
  const options = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]

    if (arg === '--port' && args[i + 1]) {
      options.port = parseInt(args[i + 1], 10)
      i++
    } else if (arg.startsWith('--port=')) {
      options.port = parseInt(arg.split('=')[1], 10)
    } else if (arg === '--output' && args[i + 1]) {
      options.outputDir = args[i + 1]
      i++
    } else if (arg.startsWith('--output=')) {
      options.outputDir = arg.split('=')[1]
    }
  }

  return options
}

const options = parseArgs(process.argv.slice(2))
const collector = new Collector(options)

collector.start().then(function() {
  console.log(`Collectivus listening on port ${collector.port}`)
  console.log(`Writing to ${collector.outputDir}`)
})

process.on('SIGINT', function() {
  console.log('\nShutting down...')
  collector.stop().then(function() {
    process.exit(0)
  })
})
