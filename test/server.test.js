import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { Collector } from '../src/index.js'

/** @type {Collector} */
let collector
/** @type {string} */
let outputDir
/** @type {string} */
let baseUrl

beforeEach(async () => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-'))
  collector = new Collector({ port: 0, outputDir })
  await collector.start()
  const addr = collector.server?.address()
  if (!addr || typeof addr === 'string') throw new Error('no address')
  baseUrl = `http://127.0.0.1:${addr.port}`
})

afterEach(async () => {
  await collector.stop()
  fs.rmSync(outputDir, { recursive: true, force: true })
})

/**
 * @param {string} signal
 * @returns {unknown[]}
 */
function readLines(signal) {
  const file = path.join(outputDir, `${signal}.jsonl`)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
}

describe('OTLP endpoints', () => {
  it.each(['traces', 'metrics', 'logs'])('accepts POST /v1/%s', async (signal) => {
    const res = await fetch(`${baseUrl}/v1/${signal}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hello: signal }),
    })
    expect(res.status).toBe(200)
    expect(readLines(signal)).toEqual([{ hello: signal }])
  })

  it('rejects non-POST methods', async () => {
    const res = await fetch(`${baseUrl}/v1/traces`)
    expect(res.status).toBe(405)
  })

  it('returns 404 for unknown routes', async () => {
    const res = await fetch(`${baseUrl}/v1/unknown`, { method: 'POST' })
    expect(res.status).toBe(404)
  })

  it('returns 400 for invalid JSON', async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
    expect(res.status).toBe(400)
  })

  it('appends multiple payloads as separate lines', async () => {
    const headers = { 'Content-Type': 'application/json' }
    await fetch(`${baseUrl}/v1/logs`, {
      method: 'POST', headers, body: JSON.stringify({ n: 1 }),
    })
    await fetch(`${baseUrl}/v1/logs`, {
      method: 'POST', headers, body: JSON.stringify({ n: 2 }),
    })
    expect(readLines('logs')).toEqual([{ n: 1 }, { n: 2 }])
  })

  it('returns OTLP ExportPartialSuccess responses', async () => {
    const headers = { 'Content-Type': 'application/json' }
    const body = JSON.stringify({})

    const traces = await fetch(`${baseUrl}/v1/traces`, { method: 'POST', headers, body })
    expect(traces.headers.get('content-type')).toBe('application/json')
    expect(await traces.json()).toEqual({ partialSuccess: { rejectedSpans: 0 } })

    const metrics = await fetch(`${baseUrl}/v1/metrics`, { method: 'POST', headers, body })
    expect(await metrics.json()).toEqual({ partialSuccess: { rejectedDataPoints: 0 } })

    const logs = await fetch(`${baseUrl}/v1/logs`, { method: 'POST', headers, body })
    expect(await logs.json()).toEqual({ partialSuccess: { rejectedLogRecords: 0 } })
  })

  it('accepts Content-Type with charset parameter', async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ ok: true }),
    })
    expect(res.status).toBe(200)
  })

  it('rejects missing Content-Type with 415', async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      body: JSON.stringify({ ok: true }),
    })
    expect(res.status).toBe(415)
    expect(await res.json()).toMatchObject({ code: 3 })
  })

  it('rejects non-JSON Content-Type with 415', async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-protobuf' },
      body: 'binary',
    })
    expect(res.status).toBe(415)
  })
})

describe('Content-Encoding', () => {
  it('decompresses gzip bodies', async () => {
    const body = new Uint8Array(zlib.gzipSync(JSON.stringify({ compressed: true })))
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      body,
    })
    expect(res.status).toBe(200)
    expect(readLines('traces')).toEqual([{ compressed: true }])
  })

  it('decompresses deflate bodies', async () => {
    const body = zlib.deflateSync(JSON.stringify({ deflated: true }))
    const res = await fetch(`${baseUrl}/v1/metrics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'deflate' },
      body,
    })
    expect(res.status).toBe(200)
    expect(readLines('metrics')).toEqual([{ deflated: true }])
  })

  it('treats identity encoding as plain body', async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'identity' },
      body: JSON.stringify({ plain: true }),
    })
    expect(res.status).toBe(200)
    expect(readLines('traces')).toEqual([{ plain: true }])
  })

  it('rejects unknown encodings with 415', async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'br' },
      body: 'whatever',
    })
    expect(res.status).toBe(415)
  })

  it('returns 400 on malformed gzip', async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' },
      body: 'not actually gzipped',
    })
    expect(res.status).toBe(400)
  })
})
