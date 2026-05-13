import { parquetReadObjects } from 'hyparquet'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runQuery } from '../../src/cli/query.js'

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
let sinkDir
/** @type {string} */
let configPath

beforeEach(function() {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-query-'))
  sinkDir = path.join(tmpDir, 'sink')
  configPath = path.join(tmpDir, 'config.json')
  fs.writeFileSync(configPath, JSON.stringify({
    version: 1,
    sink: { type: 'file', dir: sinkDir },
    query: { parquet: { enabled: true } },
  }))
})

afterEach(function() {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

/**
 * @param {string} gatewayId
 * @param {'logs' | 'traces' | 'metrics' | 'proxy'} signal
 * @param {string} date
 * @param {Record<string, unknown>[]} rows
 */
function writeJsonl(gatewayId, signal, date, rows) {
  const dir = path.join(sinkDir, gatewayId, signal)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${date}.jsonl`), rows.map((row) => JSON.stringify(row)).join('\n') + '\n')
}

function writeAllSignals() {
  writeJsonl('gw1', 'logs', '2026-05-11', [
    {
      serviceName: 'svc-a',
      timestamp: '2026-05-11T10:00:00.000Z',
      severityNumber: 17,
      severityText: 'ERROR',
      body: 'boom',
      resource: {},
      scope: { attributes: {} },
      attributes: {},
    },
  ])
  writeJsonl('gw1', 'traces', '2026-05-11', [
    {
      serviceName: 'svc-a',
      traceId: 'trace-1',
      spanId: 'span-1',
      name: 'GET /slow',
      startTimestamp: '2026-05-11T10:00:00.000Z',
      endTimestamp: '2026-05-11T10:00:01.250Z',
      durationMs: 1250,
      status: { code: 2 },
      resource: {},
      scope: { attributes: {} },
      attributes: {},
    },
  ])
  writeJsonl('gw1', 'metrics', '2026-05-11', [
    {
      serviceName: 'svc-a',
      metricName: 'latency.ms',
      metricType: 'gauge',
      timestamp: '2026-05-11T10:00:00.000Z',
      value: 12.5,
      valueType: 'double',
      resource: {},
      scope: { attributes: {} },
      attributes: {},
    },
  ])
  writeJsonl('gw1', 'proxy', '2026-05-11', [
    {
      exchange_id: 'ex-1',
      kind: 'exchange',
      ts_start: '2026-05-11T10:00:00.000Z',
      ts_end: '2026-05-11T10:00:00.250Z',
      duration_ms: 250,
      upstream: 'anthropic',
      request: { method: 'POST', path: '/v1/messages', headers: {}, body: '{}' },
      response: { status: 500, headers: {}, body: 'err' },
      stream_event_count: 1,
    },
    { exchange_id: 'ex-1', kind: 'stream_event', t_ms: 10, event: 'message', data: '{"text":"hi"}' },
  ])
}

describe('ctvs query', function() {
  it('refreshes local JSONL into partitioned query-cache parquet with metadata', async function() {
    writeAllSignals()
    const stdout = memo()
    const stderr = memo()
    const code = await runQuery(['refresh', '--config', configPath], { stdout, stderr })
    expect(code).toBe(0)
    expect(stderr.value()).toBe('')
    expect(stdout.value()).toMatch(/Done\. 5 file\(s\) written/)

    const parquetPath = path.join(sinkDir, '.collectivus-query', 'parquet', 'proxy_exchanges', 'gateway_id=gw1', 'date=2026-05-11', 'data.parquet')
    const metaPath = `${parquetPath}.meta.json`
    expect(fs.existsSync(parquetPath)).toBe(true)
    expect(JSON.parse(fs.readFileSync(metaPath, 'utf8'))).toMatchObject({
      cache_schema_version: 1,
      dataset: 'proxy_exchanges',
      gateway_id: 'gw1',
      date: '2026-05-11',
      row_count: 1,
    })

    const buf = fs.readFileSync(parquetPath)
    const rows = await parquetReadObjects({ file: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) })
    expect(rows[0]).toMatchObject({ gateway_id: 'gw1', exchangeId: 'ex-1', responseStatus: 500 })
  })

  it('does not auto-refresh by default and prints the refresh command', async function() {
    writeJsonl('gw1', 'logs', '2026-05-11', [
      { serviceName: 'svc-a', timestamp: '2026-05-11T10:00:00.000Z', body: 'hi', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])
    const stdout = memo()
    const stderr = memo()
    const code = await runQuery(['logs', '--config', configPath], { stdout, stderr })
    expect(code).toBe(1)
    expect(stdout.value()).toBe('')
    expect(stderr.value()).toMatch(/query cache is missing/)
    expect(stderr.value()).toMatch(/Run: ctvs query refresh --config/)
  })

  it('supports --refresh always for sql and rejects arbitrary file paths', async function() {
    writeJsonl('gw1', 'logs', '2026-05-11', [
      { serviceName: 'svc-a', timestamp: '2026-05-11T10:00:00.000Z', body: 'hi', resource: {}, scope: { attributes: {} }, attributes: {} },
    ])
    const stdout = memo()
    const stderr = memo()
    const code = await runQuery([
      'sql',
      'select gateway_id, serviceName, body from logs',
      '--config', configPath,
      '--refresh', 'always',
    ], { stdout, stderr })
    expect(code).toBe(0)
    expect(stderr.value()).toBe('')
    expect(stdout.value()).toMatch(/gw1\s+svc-a\s+hi/)

    const badOut = memo()
    const badErr = memo()
    const badCode = await runQuery([
      'sql',
      'select * from "/tmp/not-allowed.parquet"',
      '--config', configPath,
    ], { stdout: badOut, stderr: badErr })
    expect(badCode).toBe(2)
    expect(badErr.value()).toMatch(/logical query tables/)
  })

  it('runs high-level metrics, proxy, tail, and schema commands', async function() {
    writeAllSignals()
    expect(await runQuery(['refresh', '--config', configPath], { stdout: memo(), stderr: memo() })).toBe(0)

    const metricsOut = memo()
    expect(await runQuery(['metrics', 'list', '--config', configPath], { stdout: metricsOut, stderr: memo() })).toBe(0)
    expect(metricsOut.value()).toMatch(/latency\.ms/)

    const proxyOut = memo()
    expect(await runQuery(['proxy', 'get', 'ex-1', '--config', configPath], { stdout: proxyOut, stderr: memo() })).toBe(0)
    expect(proxyOut.value()).toMatch(/ex-1/)
    expect(proxyOut.value()).toMatch(/anthropic/)

    const tailOut = memo()
    expect(await runQuery(['logs', 'tail', '--config', configPath], { stdout: tailOut, stderr: memo() })).toBe(0)
    expect(tailOut.value()).toMatch(/boom/)

    const schemaOut = memo()
    expect(await runQuery(['schema', 'logs', '--format', 'json'], { stdout: schemaOut, stderr: memo() })).toBe(0)
    /** @type {Array<{ name: string }>} */
    const schema = JSON.parse(schemaOut.value())
    expect(schema.map((column) => column.name)).toContain('gateway_id')
    expect(schema.map((column) => column.name)).toContain('date')
  })
})
