import { describe, expect, it } from 'vitest'
import { parseJoinArgs, resolveJoinCode, runJoin } from '../../src/cli/join.js'

function memo() {
  let buf = ''
  return {
    write(/** @type {string} */ s) { buf += s },
    value() { return buf },
  }
}

describe('join CLI', () => {
  it('prints help', async () => {
    const stdout = memo()
    const code = await runJoin(['--help'], {}, { stdout, stderr: memo() })
    expect(code).toBe(0)
    expect(stdout.value()).toMatch(/Usage:\s+ctvs join/)
  })

  it('parses join-code and rendezvous URL', () => {
    expect(parseJoinArgs(['secret-code', '--rendezvous', 'https://join.example']))
      .toEqual({ help: false, joinCode: 'secret-code', rendezvous: 'https://join.example' })
  })

  it('requires --rendezvous and validates it as http(s)', () => {
    const missing = parseJoinArgs(['secret-code'])
    expect(missing.help).toBe(false)
    if (!missing.help) expect(missing.error).toMatch(/--rendezvous is required/)

    const invalid = parseJoinArgs(['secret-code', '--rendezvous', 'file:///tmp/nope'])
    expect(invalid.help).toBe(false)
    if (!invalid.help) expect(invalid.error).toMatch(/http\(s\)/)
  })

  it('resolves a join code using POST body, not query params', async () => {
    /** @type {string | undefined} */
    let seenUrl
    /** @type {RequestInit | undefined} */
    let seenInit
    const resolved = await resolveJoinCode(
      'secret-code',
      'https://join.example/base',
      /** @type {typeof fetch} */ (async (url, init) => {
        seenUrl = String(url)
        seenInit = init
        return new Response(JSON.stringify({
          connect_url: 'https://central.example:8788/',
          gateway_id: 'gw-prod-1',
          expires_at: '2999-01-01T00:00:00.000Z',
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      })
    )

    expect(seenUrl).toBe('https://join.example/base/v1/rendezvous/resolve')
    expect(seenUrl).not.toContain('secret-code')
    expect(seenInit?.method).toBe('POST')
    expect(JSON.parse(String(seenInit?.body))).toEqual({ join_code: 'secret-code' })
    expect(resolved.connect_url).toBe('https://central.example:8788')
  })

  it('surfaces rendezvous resolve failures', async () => {
    const stderr = memo()
    const code = await runJoin(['secret', '--rendezvous', 'https://join.example'], {}, {
      stdout: memo(),
      stderr,
      fetchFn: /** @type {typeof fetch} */ (async () => new Response(
        JSON.stringify({ error: 'join code not found' }),
        { status: 404, headers: { 'content-type': 'application/json' } }
      )),
    })
    expect(code).toBe(1)
    expect(stderr.value()).toMatch(/join code not found/)
  })
})
