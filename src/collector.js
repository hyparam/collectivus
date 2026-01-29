import fs from 'node:fs'
import path from 'node:path'
import { createServer } from './server.js'

class Collector {
  constructor(options = {}) {
    this.port = options.port || 4318
    this.outputDir = options.outputDir || './otel-data'
    this.server = null
  }

  start() {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true })
    }

    this.server = createServer(this.handleData.bind(this))

    return new Promise((resolve) => {
      this.server.listen(this.port, function() {
        resolve()
      })
    })
  }

  stop() {
    return new Promise((resolve, reject) => {
      if (!this.server) {
        resolve()
        return
      }

      this.server.close(function(err) {
        if (err) {
          reject(err)
        } else {
          resolve()
        }
      })
    })
  }

  handleData(signal, data) {
    const filePath = path.join(this.outputDir, `${signal}.jsonl`)
    const line = JSON.stringify(data) + '\n'
    fs.appendFileSync(filePath, line)
  }
}

export { Collector }
