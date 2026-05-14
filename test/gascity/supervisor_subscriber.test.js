import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { NormalizerDispatcher } from '../../src/gascity/normalizer_dispatcher.js'
import { SupervisorSubscriber } from '../../src/gascity/supervisor_subscriber.js'
import { blockingSleep, holdingSseResponse, memoStream, waitFor } from './helpers.js'

describe('SupervisorSubscriber', () => {
  /** @type {string} */
  let sinkRoot
  beforeEach(async () => {
    sinkRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gascity-sup-'))
  })
  afterEach(async () => {
    await fs.rm(sinkRoot, { recursive: true, force: true })
  })

  it('spawns a session worker on session.woke and persists the lifecycle cursor', async () => {
    const stderr = memoStream()
    const dispatcher = new NormalizerDispatcher({ stderr })
    const fetchFn = vi.fn().mockImplementation(async (
      /** @type {string} */ url, /** @type {{ signal: AbortSignal }} */ opts
    ) => {
      if (url.includes('/events/stream')) {
        return holdingSseResponse(
          ['id: lc-1\nevent: session.woke\ndata: {"session_id":"hy-a","template":"desktop/refinery"}\n\n'],
          opts.signal
        )
      }
      return holdingSseResponse([], opts.signal)
    })
    const subscriber = new SupervisorSubscriber({
      city: { name: 'hyptown', api_url: 'http://h:8372' },
      sinkRoot,
      dispatcher,
      stderr,
      fetchFn,
      sleep: blockingSleep(),
    })
    subscriber.start()
    await waitFor(() => fetchFn.mock.calls.some((c) => /session\/hy-a/.test(/** @type {string} */ (c[0]))))
    await subscriber.stop()
    expect(fetchFn).toHaveBeenCalledWith(
      'http://h:8372/v0/city/hyptown/events/stream',
      expect.objectContaining({ headers: expect.objectContaining({ accept: 'text/event-stream' }) })
    )
    const cursor = JSON.parse(await fs.readFile(
      path.join(sinkRoot, '.cursors', 'hyptown', 'lifecycle.json'),
      'utf8'
    ))
    expect(cursor).toEqual({ last_event_id: 'lc-1' })
  })

  it('honors include/exclude template filters before spawning workers', async () => {
    const stderr = memoStream()
    const dispatcher = new NormalizerDispatcher({ stderr })
    const fetchFn = vi.fn().mockImplementation(async (
      /** @type {string} */ url, /** @type {{ signal: AbortSignal }} */ opts
    ) => {
      if (url.includes('/events/stream')) {
        return holdingSseResponse([
          'id: 1\nevent: session.woke\ndata: {"session_id":"sa","template":"desktop/refinery"}\n\n',
          'id: 2\nevent: session.woke\ndata: {"session_id":"sb","template":"desktop/witness"}\n\n',
          'id: 3\nevent: session.woke\ndata: {"session_id":"sc","template":"mobile/foo"}\n\n',
        ], opts.signal)
      }
      return holdingSseResponse([], opts.signal)
    })
    const subscriber = new SupervisorSubscriber({
      city: {
        name: 'hyptown',
        api_url: 'http://h:8372',
        include_templates: ['desktop/*'],
        exclude_templates: ['desktop/witness'],
      },
      sinkRoot,
      dispatcher,
      stderr,
      fetchFn,
      sleep: blockingSleep(),
    })
    subscriber.start()
    const cursorFile = path.join(sinkRoot, '.cursors', 'hyptown', 'lifecycle.json')
    await waitFor(async () => {
      try {
        const body = await fs.readFile(cursorFile, 'utf8')
        return body.includes('"last_event_id":"3"')
      } catch {
        return false
      }
    })
    await subscriber.stop()
    const sessionUrls = fetchFn.mock.calls
      .map((c) => /** @type {string} */ (c[0]))
      .filter((u) => /\/session\//.test(u))
    const sessions = sessionUrls.map((u) => /session\/([^/]+)\/stream/.exec(u)?.[1] ?? '').sort()
    expect(sessions).toEqual(['sa'])
  })

  it('retires a session worker on session.stopped', async () => {
    const stderr = memoStream()
    const dispatcher = new NormalizerDispatcher({ stderr })
    /** @type {AbortSignal | undefined} */
    let workerSignal
    const fetchFn = vi.fn().mockImplementation(async (
      /** @type {string} */ url, /** @type {{ signal: AbortSignal }} */ opts
    ) => {
      if (url.includes('/events/stream')) {
        return holdingSseResponse([
          'id: 1\nevent: session.woke\ndata: {"session_id":"hy-z","template":"desktop/x"}\n\n',
          'id: 2\nevent: session.stopped\ndata: {"session_id":"hy-z"}\n\n',
        ], opts.signal)
      }
      workerSignal = opts.signal
      return holdingSseResponse([], opts.signal)
    })
    const subscriber = new SupervisorSubscriber({
      city: { name: 'hyptown', api_url: 'http://h' },
      sinkRoot,
      dispatcher,
      stderr,
      fetchFn,
      sleep: blockingSleep(),
    })
    subscriber.start()
    await waitFor(() => workerSignal?.aborted === true, {
      message: 'expected the spawned worker to be aborted by session.stopped',
    })
    await subscriber.stop()
    expect(workerSignal?.aborted).toBe(true)
  })

  it('logs and continues on malformed lifecycle data without crashing', async () => {
    const stderr = memoStream()
    const dispatcher = new NormalizerDispatcher({ stderr })
    const fetchFn = vi.fn().mockImplementation(async (
      /** @type {string} */ url, /** @type {{ signal: AbortSignal }} */ opts
    ) => {
      if (url.includes('/events/stream')) {
        return holdingSseResponse([
          'id: 1\nevent: session.woke\ndata: not-json\n\n',
          'id: 2\nevent: session.woke\ndata: {"session_id":"ok","template":"desktop/x"}\n\n',
        ], opts.signal)
      }
      return holdingSseResponse([], opts.signal)
    })
    const subscriber = new SupervisorSubscriber({
      city: { name: 'hyptown', api_url: 'http://h' },
      sinkRoot,
      dispatcher,
      stderr,
      fetchFn,
      sleep: blockingSleep(),
    })
    subscriber.start()
    await waitFor(() => fetchFn.mock.calls.some((c) => /session\/ok\/stream/.test(/** @type {string} */ (c[0]))))
    await subscriber.stop()
    expect(stderr.value()).toMatch(/lifecycle_parse_error/)
  })

  it('resumes the lifecycle stream from the persisted cursor', async () => {
    await fs.mkdir(path.join(sinkRoot, '.cursors', 'hyptown'), { recursive: true })
    await fs.writeFile(
      path.join(sinkRoot, '.cursors', 'hyptown', 'lifecycle.json'),
      JSON.stringify({ last_event_id: 'lc-prev' }) + '\n',
      'utf8'
    )
    const stderr = memoStream()
    const dispatcher = new NormalizerDispatcher({ stderr })
    const fetchFn = vi.fn().mockImplementation(async (_url, /** @type {{ signal: AbortSignal }} */ opts) => holdingSseResponse([], opts.signal))
    const subscriber = new SupervisorSubscriber({
      city: { name: 'hyptown', api_url: 'http://h' },
      sinkRoot,
      dispatcher,
      stderr,
      fetchFn,
      sleep: blockingSleep(),
    })
    subscriber.start()
    await waitFor(() => fetchFn.mock.calls.length >= 1)
    await subscriber.stop()
    const headers = /** @type {{ headers: Record<string, string> }} */ (fetchFn.mock.calls[0][1]).headers
    expect(headers['Last-Event-ID']).toBe('lc-prev')
  })

  it('does nothing when only ping/heartbeat events arrive', async () => {
    const stderr = memoStream()
    const dispatcher = new NormalizerDispatcher({ stderr })
    const fetchFn = vi.fn().mockImplementation(async (
      /** @type {string} */ url, /** @type {{ signal: AbortSignal }} */ opts
    ) => {
      if (url.includes('/events/stream')) {
        return holdingSseResponse([
          ': heartbeat comment\n\n',
          'event: ping\ndata: \n\n',
        ], opts.signal)
      }
      return holdingSseResponse([], opts.signal)
    })
    const subscriber = new SupervisorSubscriber({
      city: { name: 'hyptown', api_url: 'http://h' },
      sinkRoot,
      dispatcher,
      stderr,
      fetchFn,
      sleep: blockingSleep(),
    })
    subscriber.start()
    await waitFor(() => fetchFn.mock.calls.length >= 1)
    // Give the supervisor a beat to consume the chunks.
    await new Promise((r) => setTimeout(r, 30))
    await subscriber.stop()
    // No session was spawned — only the lifecycle stream was opened.
    const sessionFetches = fetchFn.mock.calls.filter((c) => /\/session\//.test(/** @type {string} */ (c[0])))
    expect(sessionFetches).toHaveLength(0)
  })
})
