import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createUploader } from '../../src/upload/index.js'

/** @type {string} */
let outputDir

beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-create-uploader-'))
})

afterEach(() => {
  vi.useRealTimers()
  fs.rmSync(outputDir, { recursive: true, force: true })
})

/**
 * @param {string} service
 * @param {'logs' | 'traces' | 'metrics'} signal
 * @param {string} date
 * @returns {void}
 */
function seed(service, signal, date) {
  const dir = path.join(outputDir, 'services', service)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, `${signal}-${date}.jsonl`),
    JSON.stringify({ serviceName: service, body: 'x', resource: {}, scope: { attributes: {} }, attributes: {} }) + '\n'
  )
}

describe('createUploader', () => {
  it('does not schedule a fast retry for permanent upload failures', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-07T08:00:00Z'))
    seed('svc-a', 'logs', '2026-05-06')

    const connector = {
      scheme: 'failing',
      putObject() {
        return Promise.reject(Object.assign(new Error('s3 PUT returned 403'), { statusCode: 403 }))
      },
      headObject() { return Promise.resolve(null) },
    }

    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const uploader = createUploader({
      outputDir,
      connector,
      options: { bucket: 'b', prefix: 'collectivus', time: '12:00', signals: ['logs'], catchupDays: 7, region: 'us-east-1' },
    })
    await uploader.start()
    errSpy.mockRestore()

    expect(timeoutSpy).toHaveBeenCalled()
    expect(timeoutSpy.mock.calls.at(-1)?.[1]).toBe(4 * 60 * 60 * 1000)

    await uploader.stop()
  })
})
