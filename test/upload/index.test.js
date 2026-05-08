import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createUploader } from '../../src/upload/index.js'

/** @type {string} */
let outputDir

beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'collectivus-create-uploader-env-'))
})

afterEach(() => {
  fs.rmSync(outputDir, { recursive: true, force: true })
})

describe('createUploader env validation', () => {
  it('throws synchronously when the default S3 connector is selected and AWS creds are absent', () => {
    expect(() => createUploader({
      outputDir,
      options: { bucket: 'b' },
      env: {},
    })).toThrow(/AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be set/)
  })

  it('does not require AWS creds when an explicit connector override is provided', () => {
    const stubConnector = {
      scheme: 'stub',
      putObject() { return Promise.resolve() },
      headObject() { return Promise.resolve(undefined) },
    }
    expect(() => createUploader({
      outputDir,
      options: { bucket: 'b' },
      connector: stubConnector,
      env: {},
    })).not.toThrow()
  })

  it('builds a real S3 connector when AWS creds are present', () => {
    const uploader = createUploader({
      outputDir,
      options: { bucket: 'b' },
      env: { AWS_ACCESS_KEY_ID: 'id', AWS_SECRET_ACCESS_KEY: 'secret' },
    })
    expect(typeof uploader.start).toBe('function')
    expect(typeof uploader.stop).toBe('function')
  })
})
