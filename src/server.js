import http from 'node:http'

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

    let body = ''
    req.on('data', function(chunk) {
      body += chunk.toString()
    })

    req.on('end', function() {
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

    req.on('error', function(err) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: err.message }))
    })
  })

  return server
}

export { createServer }
