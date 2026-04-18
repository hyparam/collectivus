import { describe, expect, it } from 'vitest'
import { resolveOptions } from '../src/config.js'

describe('resolveOptions', () => {
  it('returns empty options when nothing is set', () => {
    expect(resolveOptions([], {})).toEqual({})
  })

  it('reads COLLECTIVUS_PORT and COLLECTIVUS_OUTPUT_DIR from env', () => {
    const opts = resolveOptions([], {
      COLLECTIVUS_PORT: '8080',
      COLLECTIVUS_OUTPUT_DIR: '/tmp/otel',
    })
    expect(opts).toEqual({ port: 8080, outputDir: '/tmp/otel' })
  })

  it('ignores non-numeric COLLECTIVUS_PORT', () => {
    expect(resolveOptions([], { COLLECTIVUS_PORT: 'not-a-port' })).toEqual({})
  })

  it('gives argv precedence over env', () => {
    const opts = resolveOptions(
      ['--port', '9000', '--output', '/tmp/override'],
      { COLLECTIVUS_PORT: '8080', COLLECTIVUS_OUTPUT_DIR: '/tmp/env' }
    )
    expect(opts).toEqual({ port: 9000, outputDir: '/tmp/override' })
  })

  it('supports --port=N and --output=DIR equals syntax', () => {
    expect(resolveOptions(['--port=9000', '--output=/tmp/x'], {})).toEqual({
      port: 9000,
      outputDir: '/tmp/x',
    })
  })

  it('leaves keys unset when only one of port/outputDir is provided', () => {
    expect(resolveOptions([], { COLLECTIVUS_PORT: '9001' })).toEqual({ port: 9001 })
    expect(resolveOptions(['--output', '/tmp/only'], {})).toEqual({ outputDir: '/tmp/only' })
  })
})
