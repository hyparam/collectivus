import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'
import { Collector } from '../src/index.js'
import { bytesField, fixed64Field, lenDelim, stringField, u8 } from './helpers.js'

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
  const file = path.join(outputDir, signal, `${new Date().toISOString().slice(0, 10)}.jsonl`)
  if (!fs.existsSync(file)) return []
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
}

/**
 * @param {string} serviceName
 * @returns {unknown[]}
 */
function readNormalizedLogLines(serviceName) {
  const file = path.join(outputDir, 'logs-by-service', serviceName, `${new Date().toISOString().slice(0, 10)}.jsonl`)
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

  it('writes normalized one-row-per-log-record files partitioned by service.name', async () => {
    const payload = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'svc-a' } },
            ],
          },
          scopeLogs: [
            {
              scope: { name: 'test.scope', version: '1.2.3' },
              logRecords: [
                {
                  timeUnixNano: '1776886719688000000',
                  severityNumber: 9,
                  severityText: 'INFO',
                  body: { stringValue: 'hello 1' },
                  attributes: [{ key: 'k', value: { stringValue: 'v1' } }],
                },
                {
                  timeUnixNano: '1776886719689000000',
                  severityNumber: 13,
                  severityText: 'WARN',
                  body: { stringValue: 'hello 2' },
                  attributes: [{ key: 'k', value: { stringValue: 'v2' } }],
                },
              ],
            },
          ],
        },
      ],
    }

    const res = await fetch(`${baseUrl}/v1/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    expect(res.status).toBe(200)

    expect(readLines('logs')).toEqual([payload])
    expect(readNormalizedLogLines('svc-a')).toEqual([
      expect.objectContaining({
        serviceName: 'svc-a',
        timestamp: '2026-04-22T19:38:39.688Z',
        severityNumber: 9,
        severityText: 'INFO',
        body: 'hello 1',
        resource: { 'service.name': 'svc-a' },
        scope: { name: 'test.scope', version: '1.2.3', attributes: {} },
        attributes: { k: 'v1' },
      }),
      expect.objectContaining({
        serviceName: 'svc-a',
        timestamp: '2026-04-22T19:38:39.689Z',
        severityNumber: 13,
        severityText: 'WARN',
        body: 'hello 2',
        resource: { 'service.name': 'svc-a' },
        scope: { name: 'test.scope', version: '1.2.3', attributes: {} },
        attributes: { k: 'v2' },
      }),
    ])
  })

  it('uses _unknown when service.name is missing', async () => {
    /** @type {unknown} */
    const payload = {
      resourceLogs: [
        {
          resource: { attributes: [] },
          scopeLogs: [
            {
              logRecords: [
                { body: { stringValue: 'missing service name' } },
              ],
            },
          ],
        },
      ],
    }
    const res = await fetch(`${baseUrl}/v1/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    expect(res.status).toBe(200)
    expect(readNormalizedLogLines('_unknown')).toEqual([
      expect.objectContaining({
        serviceName: '_unknown',
        body: 'missing service name',
      }),
    ])
  })

  it('ignores malformed OTLP timestamps instead of failing the request', async () => {
    const payload = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'svc-a' } },
            ],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: 'not-a-number',
                  observedTimeUnixNano: '999999999999999999999999999999999999',
                  body: { stringValue: 'bad timestamps' },
                },
              ],
            },
          ],
        },
      ],
    }

    const res = await fetch(`${baseUrl}/v1/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    expect(res.status).toBe(200)
    expect(readNormalizedLogLines('svc-a')).toEqual([
      expect.not.objectContaining({
        timestamp: expect.anything(),
      }),
    ])
    expect(readNormalizedLogLines('svc-a')).toEqual([
      expect.not.objectContaining({
        observedTimestamp: expect.anything(),
      }),
    ])
    expect(readNormalizedLogLines('svc-a')).toEqual([
      expect.objectContaining({
        serviceName: 'svc-a',
        body: 'bad timestamps',
      }),
    ])
  })

  it('preserves empty-string AnyValue strings in normalized logs', async () => {
    const payload = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: 'svc-a' } },
            ],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  body: { stringValue: '' },
                  attributes: [
                    { key: 'empty', value: { stringValue: '' } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }

    const res = await fetch(`${baseUrl}/v1/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    expect(res.status).toBe(200)
    expect(readNormalizedLogLines('svc-a')).toEqual([
      expect.objectContaining({
        serviceName: 'svc-a',
        body: '',
        attributes: { empty: '' },
      }),
    ])
  })

  it('neutralizes dot segments in service-based log paths', async () => {
    const payload = {
      resourceLogs: [
        {
          resource: {
            attributes: [
              { key: 'service.name', value: { stringValue: '..' } },
            ],
          },
          scopeLogs: [
            {
              logRecords: [
                {
                  body: { stringValue: 'dot segment service' },
                },
              ],
            },
          ],
        },
      ],
    }

    const res = await fetch(`${baseUrl}/v1/logs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    expect(res.status).toBe(200)
    expect(readNormalizedLogLines('_dotdot')).toEqual([
      expect.objectContaining({
        serviceName: '..',
        body: 'dot segment service',
      }),
    ])
    expect(fs.existsSync(path.join(outputDir, `${new Date().toISOString().slice(0, 10)}.jsonl`))).toBe(false)
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

  it('rejects unsupported Content-Type with 415', async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
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

  it('decodes protobuf trace bodies', async () => {
    const span = [
      ...bytesField(1, new Array(16).fill(0x01)),
      ...bytesField(2, new Array(8).fill(0x02)),
      ...stringField(5, 'GET /'),
      ...fixed64Field(7, 1n),
      ...fixed64Field(8, 2n),
    ]
    const body = Buffer.from(u8(lenDelim(1, lenDelim(2, lenDelim(2, span)))))

    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-protobuf' },
      body,
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/x-protobuf')
    expect(await res.arrayBuffer()).toEqual(new ArrayBuffer(0))
    const lines = readLines('traces')
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatchObject({
      resourceSpans: [{ scopeSpans: [{ spans: [{ name: 'GET /' }] }] }],
    })
  })

  it('decodes gzipped protobuf metric bodies', async () => {
    const metric = [...stringField(1, 'm'), ...lenDelim(5, lenDelim(1, fixed64Field(3, 100n)))]
    const proto = u8(lenDelim(1, lenDelim(2, lenDelim(2, metric))))
    const body = Buffer.from(zlib.gzipSync(proto))

    const res = await fetch(`${baseUrl}/v1/metrics`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-protobuf', 'Content-Encoding': 'gzip' },
      body,
    })
    expect(res.status).toBe(200)
    const lines = readLines('metrics')
    expect(lines[0]).toMatchObject({
      resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name: 'm' }] }] }],
    })
  })

  it('returns 400 on malformed protobuf', async () => {
    const res = await fetch(`${baseUrl}/v1/traces`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-protobuf' },
      body: Buffer.from([0xff, 0xff, 0xff]),
    })
    expect(res.status).toBe(400)
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
