import { describe, expect, it } from 'vitest'
import { NormalizerDispatcher, resolveProvider } from '../../src/gascity/normalizer_dispatcher.js'

/**
 * @returns {{ write: (s: string) => void, value: () => string }}
 */
function memoStream() {
  let buf = ''
  return {
    write: (s) => { buf += s },
    value: () => buf,
  }
}

/** @type {import('../../src/gascity/types.d.ts').SessionContext} */
const ctx = { city: 'hyptown', sessionId: 'hy-1', template: 'desktop/x', rig: undefined, alias: undefined }

describe('resolveProvider', () => {
  it('reads the top-level provider field', () => {
    expect(resolveProvider({ provider: 'claude', frame: {} })).toBe('claude')
  })

  it('falls through to the response envelope', () => {
    expect(resolveProvider({ response: { provider: 'codex' } })).toBe('codex')
  })

  it('falls through to the inner frame envelope', () => {
    expect(resolveProvider({ frame: { provider: 'gemini' } })).toBe('gemini')
  })

  it('returns undefined for non-objects and missing providers', () => {
    expect(resolveProvider(undefined)).toBeUndefined()
    expect(resolveProvider({})).toBeUndefined()
    expect(resolveProvider({ frame: {} })).toBeUndefined()
  })
})

describe('NormalizerDispatcher', () => {
  it('routes to a registered normalizer by provider name', () => {
    const stderr = memoStream()
    const dispatcher = new NormalizerDispatcher({ stderr })
    /** @type {Array<{ frame: unknown, ctx: unknown }>} */
    const seen = []
    dispatcher.register('claude', (frame, c) => { seen.push({ frame, ctx: c }) })
    const frame = { provider: 'claude', uuid: 'u-1' }
    dispatcher.dispatch(frame, ctx)
    expect(seen).toEqual([{ frame, ctx }])
    expect(stderr.value()).toBe('')
  })

  it('falls through to passthrough when provider is not registered', () => {
    const stderr = memoStream()
    const dispatcher = new NormalizerDispatcher({ stderr })
    /** @type {unknown[]} */
    const seen = []
    dispatcher.passthrough = (frame) => { seen.push(frame) }
    const frame = { provider: 'gemini' }
    dispatcher.dispatch(frame, ctx)
    expect(seen).toEqual([frame])
  })

  it('catches normalizer exceptions and logs without crashing the loop', () => {
    const stderr = memoStream()
    const dispatcher = new NormalizerDispatcher({ stderr })
    dispatcher.register('claude', () => { throw new Error('boom') })
    /** @type {unknown[]} */
    const downstream = []
    dispatcher.register('codex', (frame) => { downstream.push(frame) })
    dispatcher.dispatch({ provider: 'claude' }, ctx)
    dispatcher.dispatch({ provider: 'codex' }, ctx)
    expect(downstream).toEqual([{ provider: 'codex' }])
    expect(stderr.value()).toMatch(/normalizer error provider=claude session=hy-1 err=boom/)
  })

  it('routes to passthrough when the envelope has no provider tag', () => {
    const stderr = memoStream()
    const dispatcher = new NormalizerDispatcher({ stderr })
    /** @type {unknown[]} */
    const seen = []
    dispatcher.passthrough = (frame) => { seen.push(frame) }
    dispatcher.dispatch({ uuid: 'no-provider' }, ctx)
    expect(seen).toEqual([{ uuid: 'no-provider' }])
  })

  it('ships built-in stubs for claude and codex (overridable by beads 2/4)', () => {
    const stderr = memoStream()
    const dispatcher = new NormalizerDispatcher({ stderr })
    expect(dispatcher.registry.has('claude')).toBe(true)
    expect(dispatcher.registry.has('codex')).toBe(true)
    // Stubs are no-ops — calling them must not throw or write to stderr.
    dispatcher.dispatch({ provider: 'claude' }, ctx)
    dispatcher.dispatch({ provider: 'codex' }, ctx)
    expect(stderr.value()).toBe('')
  })
})
