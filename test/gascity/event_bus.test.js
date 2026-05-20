import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { SupervisorEventSubscriber } from '../../src/gascity/event_bus.js'
import { GascityEventWriter } from '../../src/gascity/event_writer.js'
import { blockingSleep, holdingSseResponse, memoStream, waitFor } from './helpers.js'

describe('SupervisorEventSubscriber', () => {
  /** @type {string} */
  let sinkRoot

  beforeEach(async () => {
    sinkRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gascity-events-'))
  })

  afterEach(async () => {
    await fs.rm(sinkRoot, { recursive: true, force: true })
  })

  it('records supervisor event bus snapshots and stream events', async () => {
    const stderr = memoStream()
    const writer = new GascityEventWriter({ root: sinkRoot, stderr })
    const fetchFn = vi.fn().mockImplementation(async (
      /** @type {string} */ url, /** @type {{ signal: AbortSignal }} */ opts
    ) => {
      if (url === 'http://h:8372/v0/events') {
        return jsonResponse({
          items: [{
            city: 'hyptown',
            seq: 10,
            type: 'city.created',
            ts: '2026-05-20T00:00:00.000Z',
            actor: 'supervisor',
          }],
        })
      }
      if (url === 'http://h:8372/v0/events/stream') {
        return holdingSseResponse(
          [
            'id: 11\nevent: event\ndata: {"city":"hyptown","seq":11,"type":"session.woke","ts":"2026-05-20T00:00:01.000Z","subject":"hy-a","payload":{"template":"desktop/refinery"}}\n\n',
          ],
          opts.signal
        )
      }
      return holdingSseResponse([], opts.signal)
    })
    const subscriber = new SupervisorEventSubscriber({
      apiUrl: 'http://h:8372',
      eventSinkRoot: sinkRoot,
      writer,
      stderr,
      fetchFn,
      sleep: blockingSleep(),
    })
    subscriber.start()
    const eventsPath = path.join(
      sinkRoot,
      'date=2026-05-20',
      'event_scope=supervisor',
      'city=hyptown',
      'events.jsonl'
    )
    await waitFor(async () => {
      const rows = await readJsonlFile(eventsPath)
      return rows.length === 2
    })
    await subscriber.stop()
    await writer.stop()

    expect(fetchFn).toHaveBeenCalledWith(
      'http://h:8372/v0/events',
      expect.objectContaining({ headers: expect.objectContaining({ accept: 'application/json' }) })
    )
    expect(fetchFn).toHaveBeenCalledWith(
      'http://h:8372/v0/events/stream',
      expect.objectContaining({ headers: expect.objectContaining({ accept: 'text/event-stream' }) })
    )
    const rows = await readJsonlFile(eventsPath)
    expect(rows.map((row) => row.type).sort()).toEqual(['city.created', 'session.woke'])
    expect(rows.find((row) => row.type === 'session.woke')).toMatchObject({
      gateway_id: 'gascity-scribe',
      event_scope: 'supervisor',
      city: 'hyptown',
      supervisor_url: 'http://h:8372',
      seq: 11,
      event_id: '11',
      subject: 'hy-a',
    })
  })
})

/**
 * @param {unknown} body
 * @returns {Response}
 */
function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

/**
 * @param {string} filePath
 * @returns {Promise<Record<string, unknown>[]>}
 */
async function readJsonlFile(filePath) {
  try {
    const body = await fs.readFile(filePath, 'utf8')
    return body.trim().split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
  } catch (err) {
    if (err && typeof err === 'object' && /** @type {NodeJS.ErrnoException} */ (err).code === 'ENOENT') return []
    throw err
  }
}
