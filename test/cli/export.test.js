import { parquetReadObjects } from 'hyparquet'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { discoverExportJobs, exportProxy, parseExportArgs, runExport } from '../../src/cli/export.js'

/**
 * @returns {{ write: (s: string) => void, value: () => string }}
 */
function memo() {
  let buf = ''
  return {
    write(s) { buf += s },
    value() { return buf },
  }
}

/** @type {string} */
let tmpDir
/** @type {string} */
let configPath
/** @type {string} */
let sinkDir

beforeEach(function() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-export-'))
  sinkDir = path.join(tmpDir, 'data')
  fs.mkdirSync(sinkDir, { recursive: true })
  configPath = path.join(tmpDir, 'config.json')
  fs.writeFileSync(configPath, JSON.stringify({ version: 1, sink: { type: 'file', dir: sinkDir } }))
})

afterEach(function() {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/**
 * Write OTLP rows under `<sink>/<gateway_id>/<signal>/<date>.jsonl`, the
 * unified standalone+server layout. Most fixtures continue to use the
 * service name as the gateway_id so existing assertions stay legible.
 *
 * @param {string} gatewayId
 * @param {'logs' | 'traces' | 'metrics'} signal
 * @param {string} date
 * @param {object[]} rows
 */
function writeJsonl(gatewayId, signal, date, rows) {
  const dir = path.join(sinkDir, gatewayId, signal)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${date}.jsonl`),
    rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
  )
}

const PROXY_GATEWAY_ID = 'tester'
const PROXY_DATE = '2026-05-11'

/**
 * Write rows under `<sink>/<gateway_id>/proxy/<date>.jsonl` to mimic the
 * standalone proxy FileSink layout. The default id/date keep the legacy
 * single-file fixtures readable while still exercising the new walker.
 *
 * @param {object[]} rows
 * @param {{ gatewayId?: string, date?: string }} [opts]
 * @returns {string} Absolute path of the written JSONL file.
 */
function writeProxyJsonl(rows, opts = {}) {
  const id = opts.gatewayId ?? PROXY_GATEWAY_ID
  const date = opts.date ?? PROXY_DATE
  const dir = path.join(sinkDir, id, 'proxy')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${date}.jsonl`)
  fs.writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return file
}

/**
 * @param {Partial<{ exchange_id: string, ts_start: string, ts_end: string, duration_ms: number, upstream: string, request: object, response: object, stream_event_count: number, error: string }>} [overrides]
 * @returns {Record<string, unknown>}
 */
function exchangeRow(overrides = {}) {
  return {
    exchange_id: 'abc123',
    kind: 'exchange',
    ts_start: '2026-05-08T16:55:54.798Z',
    ts_end: '2026-05-08T16:55:55.465Z',
    duration_ms: 667,
    upstream: 'anthropic',
    client: { ip: '127.0.0.1', user_agent: 'claude-cli/2.1.133' },
    request: {
      method: 'POST',
      path: '/v1/messages',
      headers: { 'content-type': 'application/json', authorization: 'REDACTED:PQAA' },
      body: '{"model":"claude-opus-4-7"}',
    },
    response: {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: '{"id":"msg_xxx"}',
    },
    stream_event_count: 0,
    error: undefined,
    ...overrides,
  }
}

describe('parseExportArgs', function() {
  it('returns help mode', function() {
    expect(parseExportArgs(['--help']).help).toBe(true)
    expect(parseExportArgs(['-h']).help).toBe(true)
  })

  it('parses --config / --out / --date / --gateway-id / --signal', function() {
    const r = parseExportArgs([
      '--config', '/c.json',
      '--out', '/o',
      '--date', '2026-05-07',
      '--gateway-id', 'svc-a',
      '--signal', 'logs',
    ])
    expect(r).toEqual({
      help: false,
      configPath: '/c.json',
      outDir: '/o',
      date: '2026-05-07',
      gatewayId: 'svc-a',
      signal: 'logs',
    })
  })

  it('rejects bad --date', function() {
    expect(parseExportArgs(['--date', 'yesterday']).error).toMatch(/YYYY-MM-DD/)
  })

  it('rejects bad --signal', function() {
    expect(parseExportArgs(['--signal', 'events']).error).toMatch(/logs, traces, or metrics/)
  })

  it('rejects unknown args', function() {
    expect(parseExportArgs(['--mystery']).error).toMatch(/unknown argument/)
  })
})

describe('discoverExportJobs', function() {
  it('returns empty when sink has no <id> dirs', function() {
    expect(discoverExportJobs(sinkDir, {})).toEqual([])
  })

  it('finds every (gateway_id, signal, date) JSONL with no filters', function() {
    writeJsonl('svc-a', 'logs', '2026-05-06', [{ serviceName: 'svc-a' }])
    writeJsonl('svc-a', 'traces', '2026-05-07', [{ serviceName: 'svc-a' }])
    writeJsonl('svc-b', 'logs', '2026-05-07', [{ serviceName: 'svc-b' }])
    const jobs = discoverExportJobs(sinkDir, {})
    expect(jobs.map((j) => `${j.gatewayId}/${j.signal}/${j.date}`)).toEqual([
      'svc-a/logs/2026-05-06',
      'svc-a/traces/2026-05-07',
      'svc-b/logs/2026-05-07',
    ])
  })

  it('filters by date / gateway-id / signal', function() {
    writeJsonl('svc-a', 'logs', '2026-05-06', [{ serviceName: 'svc-a' }])
    writeJsonl('svc-a', 'logs', '2026-05-07', [{ serviceName: 'svc-a' }])
    writeJsonl('svc-b', 'traces', '2026-05-07', [{ serviceName: 'svc-b' }])
    expect(
      discoverExportJobs(sinkDir, { date: '2026-05-07' }).map((j) => j.gatewayId)
    ).toEqual(['svc-a', 'svc-b'])
    expect(
      discoverExportJobs(sinkDir, { gatewayId: 'svc-a' }).map((j) => j.date)
    ).toEqual(['2026-05-06', '2026-05-07'])
    expect(
      discoverExportJobs(sinkDir, { signal: 'traces' }).map((j) => j.gatewayId)
    ).toEqual(['svc-b'])
  })

  it('skips files that do not match the date pattern', function() {
    const dir = path.join(sinkDir, 'svc-a', 'logs')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'README'), 'hi')
    fs.writeFileSync(path.join(dir, 'bad.jsonl'), '')
    expect(discoverExportJobs(sinkDir, {})).toEqual([])
  })

  it('skips the proxy/ and raw/ sibling subtrees', function() {
    writeJsonl('svc-a', 'logs', '2026-05-07', [{ serviceName: 'svc-a' }])
    // Sibling proxy/ and raw/ trees that should not be picked up by the
    // OTLP discovery walk.
    fs.mkdirSync(path.join(sinkDir, 'svc-a', 'proxy'), { recursive: true })
    fs.writeFileSync(path.join(sinkDir, 'svc-a', 'proxy', '2026-05-07.jsonl'), '{}\n')
    fs.mkdirSync(path.join(sinkDir, 'svc-a', 'raw', 'logs'), { recursive: true })
    fs.writeFileSync(path.join(sinkDir, 'svc-a', 'raw', 'logs', '2026-05-07.jsonl'), '{}\n')
    const jobs = discoverExportJobs(sinkDir, {})
    expect(jobs.map((j) => `${j.gatewayId}/${j.signal}/${j.date}`)).toEqual([
      'svc-a/logs/2026-05-07',
    ])
  })
})

describe('runExport', function() {
  it('writes one parquet per (service, signal, date) under <sink>/parquet by default', async function() {
    writeJsonl('svc-a', 'logs', '2026-05-07', [
      { serviceName: 'svc-a', timestamp: '2026-05-07T00:00:00Z', body: 'hi', resource: {}, scope: { attributes: {} }, attributes: {} },
      { serviceName: 'svc-a', timestamp: '2026-05-07T00:00:01Z', body: 'bye', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])
    const stdout = memo()
    const stderr = memo()
    const code = await runExport(['--config', configPath], { stdout, stderr })
    expect(stderr.value()).toBe('')
    expect(code).toBe(0)
    const outFile = path.join(sinkDir, 'parquet', 'svc-a', 'logs', 'date=2026-05-07', 'data.parquet')
    expect(fs.existsSync(outFile)).toBe(true)
    expect(stdout.value()).toMatch(/wrote .*data\.parquet \(2 rows/)

    const buf = fs.readFileSync(outFile)
    const rows = await parquetReadObjects({ file: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) })
    expect(rows).toHaveLength(2)
    expect(rows[0].serviceName).toBe('svc-a')
  })

  it('respects --out and --date filters', async function() {
    writeJsonl('svc-a', 'logs', '2026-05-06', [
      { serviceName: 'svc-a', body: 'old', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])
    writeJsonl('svc-a', 'logs', '2026-05-07', [
      { serviceName: 'svc-a', body: 'new', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])
    const outDir = path.join(tmpDir, 'pq')
    const stdout = memo()
    const stderr = memo()
    const code = await runExport(
      ['--config', configPath, '--out', outDir, '--date', '2026-05-07'],
      { stdout, stderr }
    )
    expect(code).toBe(0)
    expect(fs.existsSync(path.join(outDir, 'svc-a', 'logs', 'date=2026-05-07', 'data.parquet'))).toBe(true)
    expect(fs.existsSync(path.join(outDir, 'svc-a', 'logs', 'date=2026-05-06'))).toBe(false)
  })

  it('exports today\'s data (unlike the upload pipeline)', async function() {
    const today = new Date().toISOString().slice(0, 10)
    writeJsonl('svc-a', 'logs', today, [
      { serviceName: 'svc-a', body: 'now', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])
    const stdout = memo()
    const stderr = memo()
    const code = await runExport(['--config', configPath], { stdout, stderr })
    expect(code).toBe(0)
    expect(fs.existsSync(path.join(sinkDir, 'parquet', 'svc-a', 'logs', `date=${today}`, 'data.parquet'))).toBe(true)
  })

  it('reports nothing-to-do without failing', async function() {
    const stdout = memo()
    const stderr = memo()
    const code = await runExport(['--config', configPath], { stdout, stderr })
    expect(code).toBe(0)
    expect(stdout.value()).toMatch(/No JSONL files matched/)
  })

  it('errors when config has no sink', async function() {
    const cfg = path.join(tmpDir, 'nosink.json')
    fs.writeFileSync(cfg, JSON.stringify({ version: 1, otel: { listen: '127.0.0.1:0' } }))
    const stdout = memo()
    const stderr = memo()
    const code = await runExport(['--config', cfg], { stdout, stderr })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/sink is required/)
  })

  it('errors on missing --config', async function() {
    const stdout = memo()
    const stderr = memo()
    const code = await runExport([], { stdout, stderr })
    expect(code).toBe(2)
    expect(stderr.value()).toMatch(/--config is required/)
  })

  it('drains proxy.jsonl to <out>/proxy/exchanges.parquet', async function() {
    writeProxyJsonl([exchangeRow(), exchangeRow({ exchange_id: 'def456' })])
    const stdout = memo()
    const stderr = memo()
    const code = await runExport(['--config', configPath], { stdout, stderr })
    expect(stderr.value()).toBe('')
    expect(code).toBe(0)
    const outFile = path.join(sinkDir, 'parquet', 'proxy', 'exchanges.parquet')
    expect(fs.existsSync(outFile)).toBe(true)
    expect(stdout.value()).toMatch(/wrote .*exchanges\.parquet \(2 rows/)
    expect(stdout.value()).toMatch(/skip proxy\/stream_event: 0 rows/)

    const buf = fs.readFileSync(outFile)
    const rows = await parquetReadObjects({ file: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) })
    expect(rows).toHaveLength(2)
    expect(rows[0].exchangeId).toBe('abc123')
    expect(rows[0].upstream).toBe('anthropic')
    expect(rows[0].requestMethod).toBe('POST')
    expect(rows[0].requestPath).toBe('/v1/messages')
    expect(rows[0].responseStatus).toBe(200)
    expect(rows[0].clientIp).toBe('127.0.0.1')
    // Header maps come back as JSON objects.
    expect(typeof rows[0].requestHeaders).toBe('object')
    expect(rows[0].requestHeaders.authorization).toBe('REDACTED:PQAA')
    // Bodies preserved verbatim.
    expect(rows[0].requestBody).toBe('{"model":"claude-opus-4-7"}')
  })

  it('writes both kinds when proxy.jsonl has exchange + stream_event rows', async function() {
    writeProxyJsonl([
      exchangeRow({ stream_event_count: 2 }),
      { exchange_id: 'abc123', kind: 'stream_event', t_ms: 12, event: 'message_start', data: '{"type":"message_start"}' },
      { exchange_id: 'abc123', kind: 'stream_event', t_ms: 45, event: 'content_block_delta', data: '{"delta":{"text":"hi"}}' },
    ])
    const stdout = memo()
    const stderr = memo()
    const code = await runExport(['--config', configPath], { stdout, stderr })
    expect(code).toBe(0)
    expect(stderr.value()).toBe('')

    const exchanges = path.join(sinkDir, 'parquet', 'proxy', 'exchanges.parquet')
    const events = path.join(sinkDir, 'parquet', 'proxy', 'stream_events.parquet')
    expect(fs.existsSync(exchanges)).toBe(true)
    expect(fs.existsSync(events)).toBe(true)

    const eventBuf = fs.readFileSync(events)
    const eventRows = await parquetReadObjects({ file: eventBuf.buffer.slice(eventBuf.byteOffset, eventBuf.byteOffset + eventBuf.byteLength) })
    expect(eventRows).toHaveLength(2)
    expect(eventRows[0]).toMatchObject({
      exchangeId: 'abc123',
      tMs: 12,
      event: 'message_start',
      data: '{"type":"message_start"}',
    })
  })

  it('drains proxy.jsonl alongside OTLP files in one run', async function() {
    writeProxyJsonl([exchangeRow()])
    writeJsonl('svc-a', 'logs', '2026-05-07', [
      { serviceName: 'svc-a', body: 'hi', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])
    const stdout = memo()
    const stderr = memo()
    const code = await runExport(['--config', configPath], { stdout, stderr })
    expect(code).toBe(0)
    expect(fs.existsSync(path.join(sinkDir, 'parquet', 'proxy', 'exchanges.parquet'))).toBe(true)
    expect(fs.existsSync(path.join(sinkDir, 'parquet', 'svc-a', 'logs', 'date=2026-05-07', 'data.parquet'))).toBe(true)
    expect(stdout.value()).toMatch(/2 file\(s\)/)
  })
})

describe('exportProxy', function() {
  it('returns empty result when proxy JSONL has no rows', async function() {
    const file = writeProxyJsonl([])
    const result = await exportProxy([file], path.join(tmpDir, 'out'))
    expect(result.files).toEqual([])
    expect(result.skipped).toEqual(['exchange', 'stream_event'])
  })

  it('skips kinds that have zero rows', async function() {
    const file = writeProxyJsonl([exchangeRow()])
    const out = path.join(tmpDir, 'out')
    const result = await exportProxy([file], out)
    expect(result.files).toHaveLength(1)
    expect(result.skipped).toEqual(['stream_event'])
    expect(fs.existsSync(path.join(out, 'proxy', 'stream_events.parquet'))).toBe(false)
  })

  it('concatenates rows across multiple per-day proxy files', async function() {
    const f1 = writeProxyJsonl([exchangeRow({ exchange_id: 'd1' })], { date: '2026-05-10' })
    const f2 = writeProxyJsonl([exchangeRow({ exchange_id: 'd2' })], { date: '2026-05-11' })
    const out = path.join(tmpDir, 'out')
    const result = await exportProxy([f1, f2], out)
    expect(result.files).toHaveLength(1)
    expect(result.files[0].rows).toBe(2)
  })
})
