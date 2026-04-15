import fs from 'node:fs'
import path from 'node:path'
import { createServer } from './server.js'

class Collector {
  /** @param {{ port?: number, outputDir?: string }} [options] */
  constructor(options = {}) {
    this.port = options.port ?? 4318
    this.outputDir = options.outputDir || './otel-data'
    /** @type {import('node:http').Server | null} */
    this.server = null
  }

  start() {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true })
    }

    const server = createServer(this.handleData.bind(this))
    this.server = server

    return new Promise((resolve) => {
      server.listen(this.port, () => resolve(undefined))
    })
  }

  stop() {
    return new Promise((resolve, reject) => {
      const { server } = this
      if (!server) {
        resolve(undefined)
        return
      }

      server.close((err) => err ? reject(err) : resolve(undefined))
    })
  }

  /**
   * @param {string} signal
   * @param {unknown} data
   */
  handleData(signal, data) {
    const filePath = path.join(this.outputDir, `${signal}.jsonl`)
    fs.appendFileSync(filePath, JSON.stringify(data) + '\n')
  }
}

export { Collector }
