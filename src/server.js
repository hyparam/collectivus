import http from 'node:http'
import zlib from 'node:zlib'

function createServer(handler) {
  const server = http.createServer(function(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`)
    const path = url.pathname

    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Method not allowed' }))
      return
    }

    const validRoutes = ['/v1/traces', '/v1/metrics', '/v1/logs']
    if (!validRoutes.includes(path)) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Not found' }))
      return
    }

    const encoding = (req.headers['content-encoding'] || '').toLowerCase()
    let stream = req
    if (encoding === 'gzip') {
      stream = req.pipe(zlib.createGunzip())
    } else if (encoding === 'deflate') {
      stream = req.pipe(zlib.createInflate())
    } else if (encoding && encoding !== 'identity') {
      res.writeHead(415, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: `Unsupported Content-Encoding: ${encoding}` }))
      return
    }

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
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: 'Invalid JSON' }))
        return
      }

      const signal = path.split('/').pop()
      handler(signal, data)

      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({}))
    })

    stream.on('error', function(err) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    })
  })

  return server
}

export { createServer }
