import http from 'node:http'
import zlib from 'node:zlib'

const JSON_CT = { 'Content-Type': 'application/json' }

const emptyResponse = {
  traces: { partialSuccess: { rejectedSpans: 0 } },
  metrics: { partialSuccess: { rejectedDataPoints: 0 } },
  logs: { partialSuccess: { rejectedLogRecords: 0 } },
}

/**
 * @param {(signal: string, data: unknown) => void} handler
 * @returns {import('node:http').Server}
 */
function createServer(handler) {
  const server = http.createServer(function(req, res) {
    const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
    const path = url.pathname

    if (req.method !== 'POST') {
      res.writeHead(405, JSON_CT)
      res.end(JSON.stringify({ code: 12, message: 'Method not allowed' }))
      return
    }

    const validRoutes = ['/v1/traces', '/v1/metrics', '/v1/logs']
    if (!validRoutes.includes(path)) {
      res.writeHead(404, JSON_CT)
      res.end(JSON.stringify({ code: 5, message: 'Not found' }))
      return
    }

    const contentType = (req.headers['content-type'] || '').split(';')[0].trim().toLowerCase()
    if (contentType !== 'application/json') {
      res.writeHead(415, JSON_CT)
      res.end(JSON.stringify({ code: 3, message: 'Unsupported Content-Type: expected application/json' }))
      return
    }

    const encoding = (req.headers['content-encoding'] || '').toLowerCase()
    /** @type {NodeJS.ReadableStream} */
    let stream = req
    if (encoding === 'gzip') {
      stream = req.pipe(zlib.createGunzip())
    } else if (encoding === 'deflate') {
      stream = req.pipe(zlib.createInflate())
    } else if (encoding && encoding !== 'identity') {
      res.writeHead(415, JSON_CT)
      res.end(JSON.stringify({ code: 3, message: `Unsupported Content-Encoding: ${encoding}` }))
      return
    }

    /** @type {Buffer[]} */
    const chunks = []
    stream.on('data', function(chunk) {
      chunks.push(chunk)
    })

    stream.on('end', function() {
      const body = Buffer.concat(chunks).toString('utf8')
      let data
      try {
        data = body ? JSON.parse(body) : {}
      } catch (err) {
        console.error('Invalid JSON:', err)
        res.writeHead(400, JSON_CT)
        res.end(JSON.stringify({ code: 3, message: 'Invalid JSON' }))
        return
      }

      const signal = path.slice('/v1/'.length)
      handler(signal, data)

      res.writeHead(200, JSON_CT)
      const response = signal === 'traces' ? emptyResponse.traces
        : signal === 'metrics' ? emptyResponse.metrics
          : emptyResponse.logs
      res.end(JSON.stringify(response))
    })

    stream.on('error', function(err) {
      res.writeHead(400, JSON_CT)
      res.end(JSON.stringify({ code: 3, message: err.message }))
    })
  })

  return server
}

export { createServer }
